/**
 * RTCP receiver reports for the DisplayService media streams.
 *
 * The device's `streamConfig` sets `RTCPTimeoutEnabled: true` with
 * `RTCPTimeoutInterval: 20`, meaning it expects periodic proof that someone is
 * still listening. Without it the device **reaps the session after ~20 s** and
 * silently stops sending — measured on iOS 27.0, both the video and audio
 * streams stop dead at the 20 s mark. Sending a receiver report once a second
 * keeps the session alive indefinitely.
 *
 * The packet is an RTCP compound of a Receiver Report (RFC 3550 §6.4.2) and a
 * minimal SDES chunk (§6.5), matching what Xcode's mirror sends.
 */
import {getLogger} from '../../../../lib/logger.js';
import type {XPCDictionary} from '../../../../lib/types.js';
import type {UdpMediaReceiver} from './rtp.js';

const log = getLogger('Rtcp');

/** How often to send a receiver report. */
const DEFAULT_INTERVAL_MS = 1000;

const RTCP_VERSION_AND_COUNT = 0x81; // version 2, one report block
const RTCP_PACKET_TYPE_RR = 0xc9; // 201
const RTCP_PACKET_TYPE_SDES = 0xca; // 202

/** Where to send receiver reports, and the SSRCs identifying the session. */
export interface RtcpStreamIdentity {
  /**
   * Our synchronization source — taken from the answer's **`RemoteSSRC`**.
   * The `streamConfig` is written from the device's point of view, so its
   * "remote" is us.
   */
  localSsrc: number;
  /** The device's synchronization source — the answer's **`LocalSSRC`**. */
  remoteSsrc: number;
  /** The device's address on the tunnel. */
  host: string;
  /** The device's media source port, where receiver reports must be sent. */
  port: number;
}

/**
 * Extracts the RTCP identity from a media stream answer's `streamConfig`.
 *
 * Returns `undefined` when the device omitted the fields, in which case the
 * caller should simply skip the keepalive rather than fail the capture.
 *
 * @param streamConfig The `streamConfig` from a {@link MediaStreamAnswer}.
 * @param deviceHost The device's address on the tunnel.
 */
export function rtcpIdentityFromStreamConfig(
  streamConfig: XPCDictionary,
  deviceHost: string,
): RtcpStreamIdentity | undefined {
  const localSsrc = streamConfig.RemoteSSRC; // ours — see RtcpStreamIdentity
  const remoteSsrc = streamConfig.LocalSSRC; // the device's
  const port = streamConfig.SourcePort;
  if (typeof localSsrc !== 'number' || typeof remoteSsrc !== 'number' || typeof port !== 'number' || port === 0) {
    return undefined;
  }
  return {localSsrc, remoteSsrc, host: deviceHost, port};
}

/**
 * Builds the RTCP compound packet: a Receiver Report followed by an SDES chunk.
 *
 * Every field the device does not need is left zero — it only checks that
 * reports keep arriving. `extendedHighestSequence` is reported honestly when
 * known; zero is still a valid keepalive.
 */
export function buildReceiverReport(identity: RtcpStreamIdentity, extendedHighestSequence = 0): Buffer {
  // Receiver Report: header + one report block = 32 bytes (length 7 words + 1).
  const rr = Buffer.alloc(32);
  rr.writeUInt8(RTCP_VERSION_AND_COUNT, 0);
  rr.writeUInt8(RTCP_PACKET_TYPE_RR, 1);
  rr.writeUInt16BE(7, 2); // length in 32-bit words, minus one
  rr.writeUInt32BE(identity.localSsrc >>> 0, 4); // sender of this report: us
  rr.writeUInt32BE(identity.remoteSsrc >>> 0, 8); // the source being reported on
  // Bytes 12..15 are fraction lost + cumulative packets lost; left at zero so
  // the device never throttles its encoder on our account.
  rr.writeUInt32BE(extendedHighestSequence >>> 0, 16);
  // 20..31: interarrival jitter, last SR, delay since last SR — all zero.

  // SDES with a single source chunk and an empty CNAME: 81 ca 0002 <ssrc>
  // 01 00 00 00 — byte-identical to Xcode's.
  const sdes = Buffer.alloc(12);
  sdes.writeUInt8(RTCP_VERSION_AND_COUNT, 0);
  sdes.writeUInt8(RTCP_PACKET_TYPE_SDES, 1);
  sdes.writeUInt16BE(2, 2);
  sdes.writeUInt32BE(identity.localSsrc >>> 0, 4);
  sdes.writeUInt8(0x01, 8); // CNAME item, zero length
  // 9..11 stay zero: null terminator plus padding to a 32-bit boundary.

  return Buffer.concat([rr, sdes]);
}

/** Options for {@link RtcpKeepalive.start}. */
export interface RtcpKeepaliveOptions {
  /** How often to send a report. Defaults to 1000 ms. */
  intervalMs?: number;
  /** Label used in debug logs, e.g. `'video'`. */
  label?: string;
}

/**
 * Periodically sends RTCP receiver reports so the device keeps a media session
 * alive past its 20 s timeout.
 *
 * The first report goes out **immediately**, not on the first tick and not
 * gated on having received anything: a silent or static screen produces no
 * media for a while, and waiting would let the device reap the session before
 * any data ever arrived.
 */
export class RtcpKeepalive {
  private readonly receiver: UdpMediaReceiver;
  private readonly identity: RtcpStreamIdentity;
  private readonly label: string;
  private timer: NodeJS.Timeout | undefined;
  private extendedHighestSequence = 0;
  private cycles = 0;
  private lastSequence: number | undefined;
  private stopped = false;

  private constructor(receiver: UdpMediaReceiver, identity: RtcpStreamIdentity, label: string) {
    this.receiver = receiver;
    this.identity = identity;
    this.label = label;
  }

  /**
   * Starts sending reports, emitting the first one right away.
   *
   * @param receiver The socket the media arrives on; reports must come from it.
   * @param identity Destination and SSRCs, from {@link rtcpIdentityFromStreamConfig}.
   * @param options Interval and log label.
   */
  static start(
    receiver: UdpMediaReceiver,
    identity: RtcpStreamIdentity,
    options: RtcpKeepaliveOptions = {},
  ): RtcpKeepalive {
    const {intervalMs = DEFAULT_INTERVAL_MS, label = 'media'} = options;
    const keepalive = new RtcpKeepalive(receiver, identity, label);

    log.debug(
      `Starting ${label} RTCP keepalive to [${identity.host}]:${identity.port} ` +
        `every ${intervalMs}ms (ssrc ${identity.localSsrc} -> ${identity.remoteSsrc})`,
    );
    void keepalive.sendReport();
    keepalive.timer = setInterval(() => void keepalive.sendReport(), intervalMs);
    keepalive.timer.unref?.();
    return keepalive;
  }

  /**
   * Records a received RTP sequence number so reports carry an honest extended
   * highest-sequence value, tracking 16-bit wraparound.
   */
  observeSequence(sequence: number): void {
    if (this.lastSequence !== undefined && sequence < this.lastSequence && this.lastSequence - sequence > 0x8000) {
      this.cycles = (this.cycles + 1) & 0xffff;
    }
    this.lastSequence = sequence;
    const candidate = ((this.cycles << 16) >>> 0) + sequence;
    if (candidate > this.extendedHighestSequence) {
      this.extendedHighestSequence = candidate;
    }
  }

  /** Stops sending reports. Safe to call more than once. */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async sendReport(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const packet = buildReceiverReport(this.identity, this.extendedHighestSequence);
    await this.receiver.send(packet, this.identity.host, this.identity.port);
  }
}
