import {getLogger} from '../../../../lib/logger.js';
import {PacketLossReporter} from '../transport/packet-loss-reporter.js';
import {type RtpPacket, isNextSequence} from '../transport/rtp.js';
import {
  HevcDepacketizer,
  HevcNalType,
  buildHevcDecoderConfigurationRecord,
  hevcCodecStringFromSps,
  isKeyNalType,
  nalTypeOf,
} from './hevc.js';

const log = getLogger('AccessUnitAssembler');

/** One decoded video access unit (all NAL units of a single picture). */
export interface VideoAccessUnit {
  /** NAL units making up this picture, in bitstream order. */
  nals: Buffer[];
  /** Whether this is a keyframe (IDR/CRA) and so independently decodable. */
  isKeyFrame: boolean;
  /** RTP media-clock timestamp shared by every packet of this picture. */
  timestamp: number;
  /** Monotonic host time when the unit completed, from `performance.now()`. */
  receivedAt: number;
}

/** The HEVC parameter sets cached from the stream. */
export interface HevcParameterSets {
  /** Video parameter set. */
  vps: Buffer;
  /** Sequence parameter set. */
  sps: Buffer;
  /** Picture parameter set. */
  pps: Buffer;
}

/** Counters describing what the assembler has seen. */
export interface ScreenStreamStats {
  /** RTP packets fed in. */
  packetsReceived: number;
  /** Packets missing according to RTP sequence numbers. */
  packetsLost: number;
  /** Access units completed and delivered. */
  accessUnitsEmitted: number;
  /** Access units discarded because a packet in them was lost. */
  accessUnitsDropped: number;
}

/**
 * Turns a sequence of RTP packets into HEVC access units.
 *
 * Depacketizes each payload (RFC 7798), groups the resulting NAL units into
 * pictures using the RTP marker bit, and caches the parameter sets needed to
 * describe the stream to a decoder.
 *
 * Access units missing any packet are dropped rather than delivered: a decoder
 * fed a partial picture renders visible corruption, which then propagates
 * through every delta frame referencing it.
 *
 * This is pure bitstream logic with no I/O — {@link ScreenStreamCapture} owns
 * the socket and feeds packets in.
 */
export class AccessUnitAssembler {
  private readonly depacketizer = new HevcDepacketizer();
  private readonly lossReporter = new PacketLossReporter(log, 'video');

  private parameterSetsInternal: Partial<HevcParameterSets> = {};
  private codecStringInternal: string | undefined;
  private statsInternal: ScreenStreamStats = {
    packetsReceived: 0,
    packetsLost: 0,
    accessUnitsEmitted: 0,
    accessUnitsDropped: 0,
  };

  private currentNals: Buffer[] = [];
  private currentIsKey = false;
  private currentTimestamp = 0;
  private currentCorrupt = false;
  private lastSequence: number | undefined;

  /**
   * Feeds one RTP packet, returning a completed access unit when the packet
   * carried the marker bit and the picture arrived intact.
   */
  push(packet: RtpPacket): VideoAccessUnit | undefined {
    this.statsInternal.packetsReceived += 1;

    if (this.lastSequence !== undefined && !isNextSequence(this.lastSequence, packet.sequence)) {
      // A gap means a fragment is missing: any in-flight NAL can no longer be
      // completed, and the picture being assembled is incomplete.
      const missing = (packet.sequence - this.lastSequence - 1) & 0xffff;
      this.statsInternal.packetsLost += missing;
      this.depacketizer.reset();
      this.currentCorrupt = true;
      this.lossReporter.record(missing, packet.sequence);
    }
    this.lastSequence = packet.sequence;
    this.currentTimestamp = packet.timestamp;

    for (const nal of this.depacketizer.push(packet.payload)) {
      this.absorbNal(nal);
    }

    return packet.marker ? this.completeAccessUnit() : undefined;
  }

  /** Parameter sets seen so far; complete once VPS, SPS and PPS have arrived. */
  get parameterSets(): HevcParameterSets | undefined {
    const {vps, sps, pps} = this.parameterSetsInternal;
    return vps && sps && pps ? {vps, sps, pps} : undefined;
  }

  /**
   * The WebCodecs / MIME codec string (e.g. `hev1.1.6.L120.90`), available once
   * the SPS has arrived.
   */
  get codecString(): string | undefined {
    return this.codecStringInternal;
  }

  /**
   * The hvcC decoder configuration record, available once all three parameter
   * sets have arrived. Pair it with `toLengthPrefixed` framing.
   */
  get decoderConfigurationRecord(): Buffer | undefined {
    const sets = this.parameterSets;
    return sets ? buildHevcDecoderConfigurationRecord(sets.vps, sets.sps, sets.pps) : undefined;
  }

  /** A snapshot of the counters. */
  get stats(): ScreenStreamStats {
    return {...this.statsInternal};
  }

  /**
   * Emits any packet loss still held back by the reporter's rate limit.
   *
   * Call once the stream has ended; {@link stats} is unaffected, since it is
   * always exact.
   */
  flushDiagnostics(): void {
    this.lossReporter.flush();
  }

  private absorbNal(nal: Buffer): void {
    if (nal.length < 2) {
      return;
    }
    const nalType = nalTypeOf(nal);
    switch (nalType) {
      case HevcNalType.VPS:
        this.parameterSetsInternal.vps = nal;
        break;
      case HevcNalType.SPS:
        this.parameterSetsInternal.sps = nal;
        this.cacheCodecString(nal);
        break;
      case HevcNalType.PPS:
        this.parameterSetsInternal.pps = nal;
        break;
      default:
        break;
    }
    if (isKeyNalType(nalType)) {
      this.currentIsKey = true;
    }
    this.currentNals.push(nal);
  }

  private cacheCodecString(sps: Buffer): void {
    try {
      this.codecStringInternal = hevcCodecStringFromSps(sps);
      log.debug(`Stream codec: ${this.codecStringInternal}`);
    } catch (error) {
      log.warn(`Failed to parse the SPS: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private completeAccessUnit(): VideoAccessUnit | undefined {
    const nals = this.currentNals;
    const isKeyFrame = this.currentIsKey;
    const corrupt = this.currentCorrupt;

    this.currentNals = [];
    this.currentIsKey = false;
    this.currentCorrupt = false;

    if (corrupt || nals.length === 0) {
      if (corrupt) {
        this.statsInternal.accessUnitsDropped += 1;
      }
      return undefined;
    }

    this.statsInternal.accessUnitsEmitted += 1;
    return {nals, isKeyFrame, timestamp: this.currentTimestamp, receivedAt: performance.now()};
  }
}
