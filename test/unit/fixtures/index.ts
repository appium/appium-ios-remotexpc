import { fs, logger } from '@appium/support';
import { Server, Socket, createConnection, createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const log = logger.getLogger('fixtures');

export const UDID = '63c3d055c4f83e960e5980fa68be0fbf7d4ba74c';

let fixtureContents: Record<string, Buffer> | null = null;

export const fixtures = {
  DEVICE_LIST: 'deviceList',
  DEVICE_LIST_2: 'deviceList2',
  DEVICE_CONNECT: 'deviceConnect',
  USBMUX_TO_LOCKDOWN: 'usbmuxToLockdown',
  LOCKDOWN_GET_VALUE_OS_VERSION: 'lockdownGetValueOsVersion',
  LOCKDOWN_GET_VALUE_TIME: 'lockdownGetValueTime',
  LOCKDOWN_QUERY_TYPE: 'lockdownQueryType',
  SYSLOG_MESSAGES: 'syslogMessage',
  SYSLOG_SPLIT_MESSAGE_1: 'syslogSplitMessage1',
  SYSLOG_SPLIT_MESSAGE_2: 'syslogSplitMessage2',
  WEBINSPECTOR_MESSAGES: 'webinspector',
  WEBINSPECTOR_PARTIAL_MESSAGES: 'webinspectorPartialMessages',
  INSTALLATION_PROXY_LIST_MESSAGE: 'installationProxyListMessage',
  INSTALLATION_PROXY_INSTALL_MESSAGE: 'installationProxyInstallMessage',
  AFC_SUCCESS_RESPONSE: 'afcSuccessResponse',
  AFC_LIST_DIR_RESPONSE: 'afcListDirResponse',
  AFC_FILE_INFO_RESPONSE: 'afcFileInfoResponse',
  INSTRUMENTS_LAUNCH_APP: 'instrumentsLaunchApp',
  INSTRUMENTS_FPS: 'instrumentsFps',
};

function getFixturePath(file: string): string {
  return resolve(__dirname, file);
}

async function initFixtures(): Promise<void> {
  if (fixtureContents) {
    return;
  }

  fixtureContents = {
    [fixtures.DEVICE_LIST]: await fs.readFile(
      getFixturePath('usbmuxlistdevicemessage.bin'),
    ),
    [fixtures.DEVICE_CONNECT]: await fs.readFile(
      getFixturePath('usbmuxconnectmessage.bin'),
    ),
  };
}

interface ServerFixtureResult {
  server: Server;
  socket: Socket;
}

export async function getServerWithFixtures(
  ...args: string[]
): Promise<ServerFixtureResult> {
  await initFixtures();

  if (!fixtureContents) {
    throw new Error('Fixtures not initialized');
  }
  const fixturesToUse = args.map((key) => fixtureContents![key]);

  const server = createServer();
  server.listen();
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Invalid server address');
  }
  const socket = createConnection(address.port);
  server.on('connection', function (socket) {
    let i = 0;
    socket.on('data', function () {
      if (i < fixturesToUse.length) {
        log.debug(`Writing to socket. Message #${i}`);
        socket.write(fixturesToUse[i++]);
        log.debug(`Wrote to socket. Message #${i}`);
      }
    });
  });
  return {
    server,
    socket,
  };
}
