import { logger } from '@appium/support';
import { type AppiumLogger } from '@appium/types';

const LOG_LEVEL = (process.env.APPIUM_IOS_REMOTEXPC_LOG_LEVEL || 'info') as any;

export function getLogger(name: string): AppiumLogger {
  const log = logger.getLogger(name);
  log.level = LOG_LEVEL;
  return log;
}
