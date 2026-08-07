import {getLogger} from '../../../lib/logger.js';
import {XPCUUID} from '../../../lib/remote-xpc/xpc-uuid.js';
import {asDictionary} from '../../../lib/remote-xpc/xpc-value.js';
import type {XPCDictionary, XPCValue} from '../../../lib/types.js';
import {type CoreDeviceInvokeOptions, CoreDeviceError, CoreDeviceService} from '../core-device/core-device-service.js';
import {
  type HostEndpointIdentity,
  type VideoMediaBlobOptions,
  buildNegotiatorOfferAudio,
  buildNegotiatorOfferVideo,
  newCallId,
  newSessionId,
} from './negotiation/media-stream-offer.js';

const log = getLogger('DisplayService');

const FEATURE_GET_MEDIA_SUPPORT_INFO = 'com.apple.coredevice.feature.getmediasupportinfo';
const FEATURE_GET_MEDIA_STREAM_SERVER_STATUS = 'com.apple.coredevice.feature.getmediastreamserverstatus';
const FEATURE_START_MEDIA_STREAM = 'com.apple.coredevice.feature.startmediastream';
const FEATURE_STOP_MEDIA_STREAM = 'com.apple.coredevice.feature.stopmediastream';

const ACTION_MEDIA_STREAM_GET_SUPPORT_INFO = 'com.apple.coredevice.action.mediastreamgetsupportinfo';
const ACTION_MEDIA_STREAM_STATUS = 'com.apple.coredevice.action.mediastreamstatus';
const ACTION_MEDIA_STREAM_START = 'com.apple.coredevice.action.mediastreamstart';
const ACTION_MEDIA_STREAM_STOP = 'com.apple.coredevice.action.mediastreamstop';

/** Bit mask captured from `devicectl`; identifies host-side feature support. */
const CLIENT_SUPPORTED_FEATURES = 140n;

// Negotiator defaults captured from a live screen-sharing session.
const DEFAULT_ACCESS_NETWORK_TYPE = 1;
const DEFAULT_TRANSPORT_PROTOCOL_TYPE = 2;

const DEFAULT_NEGOTIATION_TIMEOUT_SECONDS = 20;

/**
 * `CoreDeviceError` code returned when the device's OS is too old for the
 * media-stream ("Remote control") feature. Streaming requires iOS 27.0+.
 */
export const REMOTE_CONTROL_UNSUPPORTED_ERROR_CODE = 9021;

/** Media capabilities reported by {@link DisplayService.getMediaSupportInfo}. */
export interface MediaSupportInfo {
  /** Human-readable summary of the supported-feature bit mask. */
  supportedFeaturesDescription?: string;
  /** Bit mask of the media features this device supports; `0` means none. */
  supportedFeatures?: number;
  /** Version of the device's AVConference framework. */
  avcFrameworkVersion?: string;
  [key: string]: unknown;
}

/** Media-stream server state from {@link DisplayService.getMediaStreamServerStatus}. */
export interface MediaStreamServerStatus {
  /** Whether the media-stream server is currently running. */
  running?: boolean;
  /** Active streaming sessions. */
  sessions?: unknown[];
  /** How long the server has been running, in seconds. */
  runDurationSeconds?: number;
  [key: string]: unknown;
}

/** Where the device should send RTP, and which address it sends from. */
export interface MediaStreamEndpoint {
  /** Host IPv6 address on the tunnel that the device sends RTP/RTCP to. */
  receiverIp: string;
  /** Host UDP port. It must already be bound — the device sends immediately. */
  receiverPort: number;
  /** The device's own IPv6 address (the RSD tunnel peer). */
  senderIp: string;
}

/** Options accepted by {@link DisplayService.startVideoStream}. */
export interface StartVideoStreamOptions extends VideoMediaBlobOptions, CoreDeviceInvokeOptions {
  /**
   * Target display for `CoreDeviceVideoDisplayMode=DisplayByID`. Defaults to 1,
   * the device's built-in screen.
   *
   * DisplayService itself exposes no display enumeration — its feature set is
   * limited to media-stream support, status, start and stop. The ids come from
   * the separate CoreDevice DeviceInfo service:
   * `CoreDeviceInfoService.getDisplayInfo()`
   * (`com.apple.coredevice.feature.getdisplayinfo`), whose `displays` array
   * gives each display's `displayId`, `name`, `nativeSize` and `currentMode`.
   * On an iPhone running iOS 27.0 that is `displayId: 1` for the built-in LCD
   * plus ids 2-6 for wireless (AirPlay) displays, which report a zero size
   * until something is actually connected to them.
   */
  displayId?: number;
  /** Negotiation timeout reported to the device, in seconds. Defaults to 20. */
  negotiationTimeoutSeconds?: number;
  /**
   * Stable session UUID. Xcode's mirror pairs a video and an audio stream by
   * passing the same id to both; one is generated when omitted.
   */
  clientSessionId?: XPCUUID;
  /** Host identity reported to the device. */
  hostIdentity?: HostEndpointIdentity;
}

/** Options accepted by {@link DisplayService.startAudioStream}. */
export interface StartAudioStreamOptions extends CoreDeviceInvokeOptions {
  /** Negotiation timeout reported to the device, in seconds. Defaults to 20. */
  negotiationTimeoutSeconds?: number;
  /** Stable session UUID; pass the video stream's id to group them. */
  clientSessionId?: XPCUUID;
  /** Host identity reported to the device. */
  hostIdentity?: HostEndpointIdentity;
}

/** The device's answer to a start-stream request. */
export interface MediaStreamAnswer {
  /**
   * The session id the device echoed back. Useful for pairing a video and an
   * audio stream, but *not* a stop handle — the device has no per-session stop;
   * see {@link DisplayService.stopAllMediaStreams}.
   */
  clientSessionId: XPCUUID;
  /**
   * Negotiated stream parameters (`RxPayloadType`, `SourcePort`,
   * `AudioStreamMode`, …). Empty when the device omits them.
   */
  streamConfig: XPCDictionary;
  /** The full `connection` dictionary from the answer. */
  connection: XPCDictionary;
  /** The complete raw answer, for fields this type does not model. */
  raw: XPCDictionary;
}

/**
 * CoreDevice DisplayService — live screen and system-audio streaming over
 * RemoteXPC (`com.apple.coredevice.displayservice`), the backend behind Xcode's
 * device mirroring.
 *
 * The device encodes the screen as HEVC and pushes it to the host as RTP over
 * UDP across the tunnel, so the host must bind a UDP socket *before*
 * negotiating and advertise its tunnel-side address and port.
 * {@link startVideoStream} only negotiates; see `ScreenStreamCapture` for the
 * assembled receive pipeline.
 *
 * > **Requires iOS 27.0 or later.** Earlier versions report
 * > `supportedFeatures: 0` from {@link getMediaSupportInfo} and reject
 * > {@link startVideoStream} with `CoreDeviceError`
 * > {@link REMOTE_CONTROL_UNSUPPORTED_ERROR_CODE} ("Remote control requires
 * > iOS 27.0 or later on this device"). The query methods work on older
 * > versions, so {@link isStreamingSupported} is the cheap pre-flight check.
 *
 * Which calls can throw, verified on iOS 26 and 27:
 *
 * | Method | Streaming unsupported (< iOS 27) | Supported, nothing streaming |
 * | --- | --- | --- |
 * | {@link getMediaSupportInfo} | returns `supportedFeatures: 0` | fine |
 * | {@link getMediaStreamServerStatus} | returns `running: false` | fine |
 * | {@link isStreamingSupported} | returns `false` | fine |
 * | {@link startVideoStream} / {@link startAudioStream} | throws `CoreDeviceError` {@link REMOTE_CONTROL_UNSUPPORTED_ERROR_CODE} | fine |
 * | {@link stopAllMediaStreams} | not exercised — treat as able to throw | returns `[]`, no error |
 *
 * So the two query methods and `stopAllMediaStreams` are all safe to call
 * unconditionally on a supported device, including with no stream running;
 * only the `start*` pair is gated on the OS version.
 *
 * @example
 * ```ts
 * const display = await Services.startDisplayService(udid);
 * try {
 *   if (await display.isStreamingSupported()) {
 *     const info = await display.getMediaSupportInfo();
 *   }
 * } finally {
 *   await display.close();
 * }
 * ```
 */
export class DisplayService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.displayservice';

  constructor(udid: string) {
    super(udid, DisplayService.RSD_SERVICE_NAME);
  }

  /**
   * Returns the device's supported media-stream features and AVConference
   * framework version.
   */
  async getMediaSupportInfo(options: CoreDeviceInvokeOptions = {}): Promise<MediaSupportInfo> {
    const output = await this.invoke(
      FEATURE_GET_MEDIA_SUPPORT_INFO,
      {},
      withDefaultAction(options, ACTION_MEDIA_STREAM_GET_SUPPORT_INFO),
    );
    return (asDictionary(output) ?? {}) as MediaSupportInfo;
  }

  /** Returns the media-stream server's running state and active sessions. */
  async getMediaStreamServerStatus(options: CoreDeviceInvokeOptions = {}): Promise<MediaStreamServerStatus> {
    const output = await this.invoke(
      FEATURE_GET_MEDIA_STREAM_SERVER_STATUS,
      {},
      withDefaultAction(options, ACTION_MEDIA_STREAM_STATUS),
    );
    return (asDictionary(output) ?? {}) as MediaStreamServerStatus;
  }

  /**
   * Reports whether this device can actually stream, by checking that
   * {@link getMediaSupportInfo} advertises a non-zero feature mask.
   *
   * Cheaper and clearer than discovering the limitation through a failed
   * negotiation — devices below iOS 27 report a mask of `0`.
   */
  async isStreamingSupported(options: CoreDeviceInvokeOptions = {}): Promise<boolean> {
    const {supportedFeatures} = await this.getMediaSupportInfo(options);
    return typeof supportedFeatures === 'number' && supportedFeatures !== 0;
  }

  /**
   * Negotiates an RTP video stream of one of the device's displays.
   *
   * The device begins sending RTP to `endpoint` as soon as it answers, so the
   * UDP socket must already be bound.
   *
   * @param endpoint Where the device should send RTP, and its own address.
   * @param options Display selection, session id and encoder knobs.
   */
  async startVideoStream(
    endpoint: MediaStreamEndpoint,
    options: StartVideoStreamOptions = {},
  ): Promise<MediaStreamAnswer> {
    const {
      displayId = 1,
      negotiationTimeoutSeconds = DEFAULT_NEGOTIATION_TIMEOUT_SECONDS,
      clientSessionId = XPCUUID.random(),
      hostIdentity,
      timeoutMs,
      actionIdentifier,
      ...blobOptions
    } = options;

    const negotiatorOffer = buildNegotiatorOfferVideo(newCallId(), newSessionId(), {...blobOptions, hostIdentity});
    const input: XPCDictionary = {
      ...this.buildCommonStreamInput(endpoint, negotiatorOffer, negotiationTimeoutSeconds),
      options: {
        ...this.buildCommonNegotiatorOptions(clientSessionId),
        CoreDeviceVideoDisplayMode: {string: 'DisplayByID'},
        VideoStreamForDisplayID: {int: displayId},
      },
      type: 'video',
    };

    return this.startMediaStream(input, clientSessionId, {timeoutMs, actionIdentifier});
  }

  /**
   * Negotiates an RTP stream of the device's system audio output.
   *
   * Pass the video stream's `clientSessionId` to group the two on the device,
   * the way Xcode's mirror does.
   *
   * @param endpoint Where the device should send RTP, and its own address.
   * @param options Session id and negotiation timeout.
   */
  async startAudioStream(
    endpoint: MediaStreamEndpoint,
    options: StartAudioStreamOptions = {},
  ): Promise<MediaStreamAnswer> {
    const {
      negotiationTimeoutSeconds = DEFAULT_NEGOTIATION_TIMEOUT_SECONDS,
      clientSessionId = XPCUUID.random(),
      hostIdentity,
      timeoutMs,
      actionIdentifier,
    } = options;

    const negotiatorOffer = buildNegotiatorOfferAudio(newCallId(), newSessionId(), {hostIdentity});
    const input: XPCDictionary = {
      ...this.buildCommonStreamInput(endpoint, negotiatorOffer, negotiationTimeoutSeconds),
      options: this.buildCommonNegotiatorOptions(clientSessionId),
      type: 'audio',
    };

    return this.startMediaStream(input, clientSessionId, {timeoutMs, actionIdentifier});
  }

  /**
   * Stops **every** media stream currently running on the device and returns
   * the stopped streams' ids (each is the stream's `RemoteSSRC`).
   *
   * The device offers no per-session stop: the request requires a `stopAll`
   * flag, and `stopAll: false` is rejected with
   * "Unable to stop media stream. Invalid request sent." Passing a
   * `avcMediaStreamOptionClientSessionID` alongside `stopAll: true` does not
   * narrow it either — verified on iOS 27.0 by starting a video and an audio
   * stream under different session ids and watching a single stop tear down
   * both. So if two captures are running concurrently, stopping one stops the
   * other as well.
   *
   * Safe to call when nothing is streaming: the device answers with an empty
   * `stoppedStreams` list rather than an error, so callers do not have to track
   * whether a stream is live. Verified on iOS 27.0, where the capture classes
   * call it on every teardown including repeat and no-op stops.
   *
   * A closed connection is treated as success: on some versions the device
   * tears the RemoteXPC channel down while handling the stop, before the reply
   * is written.
   */
  async stopAllMediaStreams(options: CoreDeviceInvokeOptions = {}): Promise<number[]> {
    try {
      const output = await this.invoke(
        FEATURE_STOP_MEDIA_STREAM,
        {stopAll: true},
        withDefaultAction(options, ACTION_MEDIA_STREAM_STOP),
      );
      const stopped = asDictionary(output)?.stoppedStreams;
      return Array.isArray(stopped) ? stopped.filter((id): id is number => typeof id === 'number') : [];
    } catch (error) {
      if (isConnectionTeardown(error)) {
        log.debug('Media stream stop closed the channel, which is the expected success path');
        return [];
      }
      throw error;
    }
  }

  /**
   * The host's own address on the tunnel — what the device must be told to
   * stream to. Establishes a connection if one is not already open.
   */
  async getTunnelLocalAddress(): Promise<string> {
    const transport = await this.getTransport();
    const address = transport.localAddress;
    if (!address) {
      throw new CoreDeviceError('Could not determine the host tunnel address for the media receiver');
    }
    return address;
  }

  /** The device's address on the tunnel, used as the RTP sender address. */
  async getDeviceAddress(): Promise<string> {
    const [host] = await this.resolveServiceAddress(DisplayService.RSD_SERVICE_NAME);
    return host;
  }

  /**
   * Assembles the fields both stream types share.
   *
   * `receiverPort` and `timeout` must be `BigInt`, and it is about wire typing
   * rather than magnitude — the device does treat the port as a `UInt16`.
   */
  private buildCommonStreamInput(
    endpoint: MediaStreamEndpoint,
    negotiatorOffer: Buffer,
    negotiationTimeoutSeconds: number,
  ): XPCDictionary {
    return {
      clientSupportedFeatures: CLIENT_SUPPORTED_FEATURES,
      direction: 'output',
      negotiatorOffer,
      receiverIP: endpoint.receiverIp,
      receiverPort: BigInt(endpoint.receiverPort),
      senderIP: endpoint.senderIp,
      timeout: BigInt(negotiationTimeoutSeconds),
    };
  }

  private buildCommonNegotiatorOptions(clientSessionId: XPCUUID): XPCDictionary {
    return {
      AVCMediaStreamNegotiatorAccessNetworkType: {int: DEFAULT_ACCESS_NETWORK_TYPE},
      AVCMediaStreamNegotiatorTransportProtocolType: {int: DEFAULT_TRANSPORT_PROTOCOL_TYPE},
      avcMediaStreamOptionClientSessionID: {uuid: clientSessionId},
    };
  }

  private async startMediaStream(
    input: XPCDictionary,
    clientSessionId: XPCUUID,
    options: CoreDeviceInvokeOptions,
  ): Promise<MediaStreamAnswer> {
    const output = await this.invoke(
      FEATURE_START_MEDIA_STREAM,
      input,
      withDefaultAction(options, ACTION_MEDIA_STREAM_START),
    );

    const raw = asDictionary(output) ?? {};
    const connection = asDictionary(raw.connection) ?? {};
    return {
      // Prefer the id the device echoes back; fall back to the one we sent.
      clientSessionId: extractSessionId(connection) ?? clientSessionId,
      streamConfig: asDictionary(connection.streamConfig) ?? {},
      connection,
      raw,
    };
  }
}

/**
 * Applies this service's action identifier unless the caller chose one.
 *
 * Spreading the caller's options over a default does not work here: callers
 * reach these helpers through destructured option bags, so `actionIdentifier`
 * is usually present-but-`undefined` and would erase the default.
 */
function withDefaultAction(options: CoreDeviceInvokeOptions, actionIdentifier: string): CoreDeviceInvokeOptions {
  return {...options, actionIdentifier: options.actionIdentifier ?? actionIdentifier};
}

/** Pulls the echoed session UUID out of an answer's `connection.options`. */
function extractSessionId(connection: XPCDictionary): XPCUUID | undefined {
  const options = asDictionary(connection.options);
  const wrapper = asDictionary(options?.avcMediaStreamOptionClientSessionID);
  return XPCUUID.asOptionalUuid(wrapper?.uuid as XPCValue | undefined);
}

/**
 * Whether an error is the device closing the channel rather than a real
 * failure. `stopmediastream` normally tears the connection down before the
 * reply is written.
 */
function isConnectionTeardown(error: unknown): boolean {
  if (error instanceof CoreDeviceError) {
    return error.message.includes('connection closed');
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ECONNRESET' || code === 'EPIPE';
  }
  return false;
}

export default DisplayService;
