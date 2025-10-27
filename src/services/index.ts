import {
  TunnelRegistryServer,
  startTunnelRegistryServer,
} from '../lib/tunnel/tunnel-registry-server.js';
import * as afc from './ios/afc/index.js';
import * as diagnostics from './ios/diagnostic-service/index.js';
import * as mobileImageMounter from './ios/mobile-image-mounter/index.js';
import * as powerAssertion from './ios/power-assertion/index.js';
import * as syslog from './ios/syslog-service/index.js';
import * as tunnel from './ios/tunnel-service/index.js';
import * as webinspector from './ios/webinspector/index.js';

export {
  diagnostics,
  mobileImageMounter,
  powerAssertion,
  syslog,
  tunnel,
  afc,
  webinspector,
  TunnelRegistryServer,
  startTunnelRegistryServer,
};
