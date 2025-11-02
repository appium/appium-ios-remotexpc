import { logger } from '@appium/support';

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info') as any;

export function getLogger(name: string) {
  const log = logger.getLogger(name);
  log.level = LOG_LEVEL;
  return log;
}
