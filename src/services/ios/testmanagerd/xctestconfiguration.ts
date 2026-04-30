import crypto from 'node:crypto';

import { PlistUID } from '../../../lib/plist/index.js';
import { TestmanagerdEncoder } from './testmanagerd-encoder.js';

/**
 * Parameters for creating an XCTestConfiguration
 */
export interface XCTestConfigurationParams {
  /** URL to the test bundle (e.g., file:///path/to/Runner.xctest) */
  testBundleURL: string;
  /** Session identifier UUID string. Auto-generated if not provided. */
  sessionIdentifier?: string;
  /** Target application bundle ID */
  targetApplicationBundleID?: string;
  /** Target application path */
  targetApplicationPath?: string;
  /** Whether to treat missing baselines as failures */
  treatMissingBaselinesAsFailures?: boolean;
  /** Whether to report results to IDE */
  reportResultsToIDE?: boolean;
  /** Path to automation framework */
  automationFrameworkPath?: string;
  /** Whether tests must run on main thread */
  testsMustRunOnMainThread?: boolean;
  /** Whether to initialize for UI testing */
  initializeForUITesting?: boolean;
  /** Whether to report activities */
  reportActivities?: boolean;
  /** Set of tests to skip */
  testsToSkip?: string[] | null;
  /** Set of tests to run */
  testsToRun?: string[] | null;
  /** Product module name */
  productModuleName?: string | null;
  /** Relative path to test bundle */
  testBundleRelativePath?: string | null;
  /** Arguments to pass to the target application */
  targetApplicationArguments?: string[];
  /** Environment variables for the target application */
  targetApplicationEnvironment?: Record<string, string> | null;
}

export interface NSUUIDMarker {
  __type: 'NSUUID';
  /** Canonical RFC-4122 string with dashes (e.g. `crypto.randomUUID()`). */
  uuid: string;
}

export interface NSURLMarker {
  __type: 'NSURL';
  base: string | null;
  relative: string;
}

/**
 * Extended encoder that supports XCTestConfiguration-specific types:
 * NSURL and XCTestConfiguration itself.
 *
 * Inherits NSUUID and XCTCapabilities support from TestmanagerdEncoder.
 */
export class XCTestConfigurationEncoder extends TestmanagerdEncoder {
  /**
   * Encode an XCTestConfiguration into NSKeyedArchiver format
   */
  encodeXCTestConfiguration(config: XCTestConfigurationParams): any {
    const configObj = this.buildConfigObject(config);
    return this.encode(configObj);
  }

  protected override archiveObject(value: any): number {
    if (value === null || value === undefined) {
      return 0;
    }

    if (value && typeof value === 'object') {
      if (value.__type === 'NSURL') {
        return this.archiveNSURL(value.base, value.relative);
      }
      if (value.__type === 'XCTestConfiguration') {
        return this.archiveXCTestConfiguration(value.fields);
      }
    }

    return super.archiveObject(value);
  }

  private archiveNSURL(base: string | null, relative: string): number {
    const index = this.objects.length;
    this.objects.push(null); // Placeholder

    const baseIndex = base ? this.archiveObject(base) : 0;
    const relativeIndex = this.archiveObject(relative);

    const classUid = this.getClassUid('NSURL', 'NSObject');

    this.objects[index] = {
      'NS.base': new PlistUID(baseIndex),
      'NS.relative': new PlistUID(relativeIndex),
      $class: new PlistUID(classUid),
    };

    return index;
  }

  private archiveXCTestConfiguration(fields: Record<string, any>): number {
    const index = this.objects.length;
    this.objects.push(null); // Placeholder

    const archivedFields: Record<string, any> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }
      if (value === null) {
        // Null values must be encoded as $null references (index 0).
        // NSKeyedUnarchiver expects all keys to be present.
        archivedFields[key] = new PlistUID(0);
      } else if (typeof value === 'boolean' || typeof value === 'number') {
        // Booleans and numbers are the ONLY types stored inline.
        archivedFields[key] = value;
      } else if (value instanceof PlistUID) {
        // PlistUID values (e.g. formatVersion = UID(2)) must be stored as
        // separate $objects entries. In bpylist2, plistlib.UID is a
        // "primitive_type" (not inline) — archive() adds it to $objects
        // and returns a UID reference. If we inline UID(2), NSKeyedUnarchiver
        // would dereference it to $objects[2] instead of treating it as the
        // raw UID value 2.
        const uidIndex = this.objects.length;
        this.objects.push(value);
        archivedFields[key] = new PlistUID(uidIndex);
      } else {
        // All other types (strings, buffers, objects, arrays, custom markers)
        // are archived as separate $objects entries and referenced by PlistUID.
        archivedFields[key] = new PlistUID(this.archiveObject(value));
      }
    }

    const classUid = this.getClassUid('XCTestConfiguration', 'NSObject');

    this.objects[index] = {
      ...archivedFields,
      $class: new PlistUID(classUid),
    };

    return index;
  }

  private buildConfigObject(
    config: XCTestConfigurationParams,
  ): Record<string, any> {
    const sessionId = config.sessionIdentifier || crypto.randomUUID();

    return {
      __type: 'XCTestConfiguration',
      fields: {
        testBundleURL: {
          __type: 'NSURL',
          base: null,
          relative: config.testBundleURL,
        },
        sessionIdentifier: {
          __type: 'NSUUID',
          uuid: sessionId,
        },
        // formatVersion MUST be a PlistUID, not a plain integer
        formatVersion: new PlistUID(2),
        treatMissingBaselinesAsFailures:
          config.treatMissingBaselinesAsFailures ?? false,
        targetApplicationBundleID: config.targetApplicationBundleID || null,
        targetApplicationPath:
          config.targetApplicationPath || '/tmp/XCTestTargetApp.app',
        reportResultsToIDE: config.reportResultsToIDE ?? true,
        automationFrameworkPath:
          config.automationFrameworkPath ||
          '/Developer/Library/PrivateFrameworks/XCTAutomationSupport.framework',
        testsMustRunOnMainThread: config.testsMustRunOnMainThread ?? true,
        initializeForUITesting: config.initializeForUITesting ?? true,
        reportActivities: config.reportActivities ?? true,
        testsToSkip: config.testsToSkip || null,
        testsToRun: config.testsToRun || null,
        productModuleName: config.productModuleName || null,
        testBundleRelativePath: config.testBundleRelativePath || null,
        aggregateStatisticsBeforeCrash: {
          XCSuiteRecordsKey: {},
        },
        baselineFileRelativePath: null,
        baselineFileURL: null,
        defaultTestExecutionTimeAllowance: null,
        disablePerformanceMetrics: false,
        emitOSLogs: false,
        gatherLocalizableStringsData: false,
        maximumTestExecutionTimeAllowance: null,
        randomExecutionOrderingSeed: null,
        systemAttachmentLifetime: 2,
        targetApplicationArguments: config.targetApplicationArguments ?? [],
        targetApplicationEnvironment:
          config.targetApplicationEnvironment ?? null,
        testApplicationDependencies: {},
        testApplicationUserOverrides: null,
        testExecutionOrdering: 0,
        testTimeoutsEnabled: false,
        testsDrivenByIDE: false,
        userAttachmentLifetime: 1,
      },
    };
  }
}

/**
 * Helper to create an NSUUID marker object.
 * `uuid` must already be canonical (e.g. from `crypto.randomUUID()` or
 * `canonicalizeUuidString` from `./uuid.js`).
 */
export function createNSUUID(uuid: string): NSUUIDMarker {
  return { __type: 'NSUUID', uuid };
}

/**
 * Helper to create an NSURL marker object
 */
export function createNSURL(
  relative: string,
  base: string | null = null,
): NSURLMarker {
  return { __type: 'NSURL', base, relative };
}
