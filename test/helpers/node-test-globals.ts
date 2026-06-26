import assert from 'node:assert/strict';
import {
  after as nodeAfter,
  afterEach as nodeAfterEach,
  before as nodeBefore,
  beforeEach as nodeBeforeEach,
  describe as nodeDescribe,
  it as nodeIt,
  type TestContext,
} from 'node:test';

type MaybePromise<T> = T | Promise<T>;
type HookFn = (this: MochaCompatContext) => MaybePromise<void>;
type TestFn = (this: MochaCompatContext, t: TestContext) => MaybePromise<void>;
type SuiteFn = (this: MochaCompatContext) => MaybePromise<void>;

interface MochaCompatContext {
  skip: (message?: string) => void;
  timeout: (ms: number) => void;
}

interface ChainableAssertion {
  and: ChainableAssertion;
  at: ChainableAssertion;
  be: ChainableAssertion;
  been: ChainableAssertion;
  deep: ChainableAssertion;
  false: ChainableAssertion;
  has: ChainableAssertion;
  have: ChainableAssertion;
  is: ChainableAssertion;
  not: ChainableAssertion;
  null: ChainableAssertion;
  of: ChainableAssertion;
  same: ChainableAssertion;
  that: ChainableAssertion;
  to: ChainableAssertion;
  true: ChainableAssertion;
  undefined: ChainableAssertion;
  which: ChainableAssertion;
  with: ChainableAssertion;
  a: (typeName: string) => ChainableAssertion;
  an: (typeName: string) => ChainableAssertion;
  contain: (expected: unknown) => ChainableAssertion;
  contains: (expected: unknown) => ChainableAssertion;
  closeTo: (expected: number, delta: number, message?: string) => ChainableAssertion;
  empty: ChainableAssertion;
  equal: (expected: unknown, message?: string) => ChainableAssertion;
  eql: (expected: unknown, message?: string) => ChainableAssertion;
  eventually: ChainableAssertion;
  exist: ChainableAssertion;
  fulfilled: Promise<ChainableAssertion>;
  greaterThanOrEqual: (expected: number | bigint, message?: string) => ChainableAssertion;
  greaterThan: (expected: number | bigint, message?: string) => ChainableAssertion;
  gt: (expected: number | bigint, message?: string) => ChainableAssertion;
  include: ((expected: unknown) => ChainableAssertion) & ChainableAssertion;
  includes: ((expected: unknown) => ChainableAssertion) & ChainableAssertion;
  instanceOf: (expected: abstract new (...args: never[]) => unknown) => ChainableAssertion;
  instanceof: (expected: abstract new (...args: never[]) => unknown) => ChainableAssertion;
  keys: (...expected: string[]) => ChainableAssertion;
  least: (expected: number | bigint, message?: string) => ChainableAssertion;
  length: ((expected: number, message?: string) => ChainableAssertion) & ChainableAssertion;
  lengthOf: (expected: number, message?: string) => ChainableAssertion;
  lessThanOrEqual: (expected: number | bigint, message?: string) => ChainableAssertion;
  lessThan: (expected: number | bigint, message?: string) => ChainableAssertion;
  lt: (expected: number | bigint, message?: string) => ChainableAssertion;
  match: (expected: RegExp) => ChainableAssertion;
  members: (expected: unknown[]) => ChainableAssertion;
  most: (expected: number | bigint) => ChainableAssertion;
  oneOf: (expected: unknown[]) => ChainableAssertion;
  property: (name: string, expected?: unknown) => ChainableAssertion;
  rejected: Promise<ChainableAssertion>;
  rejectedWith: (...expected: Array<RegExp | string | (abstract new (...args: never[]) => Error)>) => Promise<ChainableAssertion>;
  satisfy: (predicate: (actual: any) => boolean) => ChainableAssertion;
  throw: (...expected: Array<RegExp | string | (abstract new (...args: never[]) => Error)>) => ChainableAssertion;
  throws: (...expected: Array<RegExp | string | (abstract new (...args: never[]) => Error)>) => ChainableAssertion;
}

interface ExpectStatic {
  (actual: unknown, message?: string): ChainableAssertion;
  fail: (message?: string) => never;
}

interface AssertionState {
  actual: unknown;
  deep: boolean;
  message?: string;
  negate: boolean;
}

interface TestApi {
  (name: string, fn?: TestFn): void;
  only: (name: string, fn?: TestFn) => void;
  skip: (name: string, fn?: TestFn) => void;
}

interface SuiteApi {
  (name: string, fn?: SuiteFn): void;
  only: (name: string, fn?: SuiteFn) => void;
  skip: (name: string, fn?: SuiteFn) => void;
}

declare global {
  var after: (fn: HookFn) => void;
  var afterEach: (fn: HookFn) => void;
  var before: (fn: HookFn) => void;
  var beforeEach: (fn: HookFn) => void;
  var describe: SuiteApi;
  var expect: ExpectStatic;
  var it: TestApi;
}

const makeContext = (t?: TestContext): MochaCompatContext => ({
  skip(message?: string) {
    t?.skip(message);
  },
  timeout() {
    // Node's test runner timeout is configured at the process level for this suite.
  },
});

const wrapHook = (fn: HookFn): any => async (t: TestContext) => fn.call(makeContext(t));
const wrapSuite = (fn: SuiteFn): any => async (t: TestContext) => fn.call(makeContext(t));
const wrapTest = (fn: TestFn) => async (t: TestContext) => fn.call(makeContext(t), t);

const describeApi = ((name: string, fn?: SuiteFn) => {
  nodeDescribe(name, fn ? wrapSuite(fn) : undefined);
}) as SuiteApi;
describeApi.only = (name: string, fn?: SuiteFn) => {
  nodeDescribe.only(name, fn ? wrapSuite(fn) : undefined);
};
describeApi.skip = (name: string, fn?: SuiteFn) => {
  nodeDescribe.skip(name, fn ? wrapSuite(fn) : undefined);
};

const itApi = ((name: string, fn?: TestFn) => {
  nodeIt(name, fn ? wrapTest(fn) : undefined);
}) as TestApi;
itApi.only = (name: string, fn?: TestFn) => {
  nodeIt.only(name, fn ? wrapTest(fn) : undefined);
};
itApi.skip = (name: string, fn?: TestFn) => {
  nodeIt.skip(name, fn ? wrapTest(fn) : undefined);
};

const compare = (state: AssertionState, assertion: () => void) => {
  if (!state.negate) {
    assertion();
    return createAssertion({...state, negate: false, deep: false});
  }

  assert.throws(assertion, undefined, state.message);
  return createAssertion({...state, negate: false, deep: false});
};

const assertType = (actual: unknown, typeName: string, message?: string) => {
  switch (typeName) {
    case 'array':
      assert.ok(Array.isArray(actual), message);
      return;
    case 'buffer':
      assert.ok(Buffer.isBuffer(actual), message);
      return;
    case 'null':
      assert.equal(actual, null, message);
      return;
    case 'object':
      assert.equal(typeof actual, 'object', message);
      assert.notEqual(actual, null, message);
      assert.ok(!Array.isArray(actual), message);
      return;
    default:
      assert.equal(typeof actual, typeName, message);
  }
};

const getLength = (actual: unknown): number => {
  if (actual == null) {
    assert.fail('expected value to have a length');
  }
  if (typeof actual === 'object' && 'size' in actual && typeof actual.size === 'number') {
    return actual.size;
  }
  if ('length' in Object(actual) && typeof Object(actual).length === 'number') {
    return Object(actual).length;
  }
  assert.fail('expected value to have a length');
};

const includes = (actual: unknown, expected: unknown) => {
  if (typeof actual === 'string') {
    assert.equal(typeof expected, 'string');
    assert.ok(actual.includes(expected as string));
    return;
  }
  if (Array.isArray(actual) || Buffer.isBuffer(actual)) {
    assert.ok(actual.includes(expected as never));
    return;
  }
  if (actual instanceof Set || actual instanceof Map) {
    assert.ok(actual.has(expected));
    return;
  }
  if (actual != null && typeof actual === 'object') {
    assert.ok(expected as PropertyKey in actual);
    return;
  }
  assert.fail('expected value to include the provided value');
};

const propertyValue = (actual: unknown, name: string): unknown => {
  assert.ok(actual != null, `expected value to have property ${name}`);
  assert.ok(name in Object(actual), `expected value to have property ${name}`);
  return (actual as Record<string, unknown>)[name];
};

const assertMembers = (actual: unknown, expected: unknown[]) => {
  assert.ok(Array.isArray(actual), 'expected value to be an array');
  for (const member of expected) {
    assert.ok(actual.includes(member), `expected array to include ${String(member)}`);
  }
};

const makeIncludeAssertion = (state: AssertionState) => {
  const includeAssertion = ((expected: unknown) => compare(state, () => includes(state.actual, expected))) as
    & ((expected: unknown) => ChainableAssertion)
    & ChainableAssertion;

  return new Proxy(includeAssertion, {
    get(target, property) {
      if (property === 'members') {
        return (expected: unknown[]) => compare(state, () => assertMembers(state.actual, expected));
      }
      if (property in target) {
        return target[property as keyof typeof target];
      }
      return createAssertion(state)[property as keyof ChainableAssertion];
    },
  });
};

const makeThrowMatcher = (
  expected: Array<RegExp | string | (abstract new (...args: never[]) => Error)>,
) => {
  const [errorType, message] = expected;
  if (typeof errorType === 'function' && message != null) {
    return (error: Error) => {
      assert.ok(error instanceof errorType);
      if (typeof message === 'string') {
        assert.ok(error.message.includes(message));
      } else if (message instanceof RegExp) {
        assert.match(error.message, message);
      }
      return true;
    };
  }
  if (typeof errorType === 'string') {
    return (error: Error) => {
      assert.ok(error.message.includes(errorType));
      return true;
    };
  }
  return errorType;
};

const assertPromise = async (state: AssertionState, rejects: boolean) => {
  assert.ok(state.actual instanceof Promise, 'expected value to be a promise');
  if (rejects === state.negate) {
    await assert.doesNotReject(state.actual);
  } else {
    await assert.rejects(state.actual);
  }
  return createAssertion({...state, negate: false, deep: false});
};

const assertRejectedWith = async (
  state: AssertionState,
  expected: Array<RegExp | string | (abstract new (...args: never[]) => Error)>,
) => {
  assert.ok(state.actual instanceof Promise, 'expected value to be a promise');
  await assert.rejects(state.actual, makeThrowMatcher(expected));
  return createAssertion({...state, negate: false, deep: false});
};

const makeLengthAssertion = (state: AssertionState) => {
  const lengthState = {...state, actual: getLength(state.actual)};
  const lengthAssertion = ((expected: number) =>
    compare(lengthState, () => assert.equal(lengthState.actual, expected, state.message))) as
    & ((expected: number) => ChainableAssertion)
    & ChainableAssertion;

  return new Proxy(lengthAssertion, {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target];
      }
      return createAssertion(lengthState)[property as keyof ChainableAssertion];
    },
  });
};

const createAssertion = (state: AssertionState): ChainableAssertion =>
  new Proxy({} as ChainableAssertion, {
    get(_target, property: string) {
      switch (property) {
        case 'and':
        case 'at':
        case 'be':
        case 'been':
        case 'has':
        case 'have':
        case 'is':
        case 'of':
        case 'same':
        case 'that':
        case 'to':
        case 'which':
        case 'with':
          return createAssertion(state);
        case 'deep':
          return createAssertion({...state, deep: true});
        case 'eventually':
          return createAssertion(state);
        case 'not':
          return createAssertion({...state, negate: !state.negate});
        case 'a':
        case 'an':
          return (typeName: string) => compare(state, () => assertType(state.actual, typeName, state.message));
        case 'closeTo':
          return (expected: number, delta: number, message?: string) =>
            compare(state, () =>
              assert.ok(Math.abs((state.actual as number) - expected) <= delta, message ?? state.message),
            );
        case 'contain':
        case 'contains':
        case 'include':
        case 'includes':
          return makeIncludeAssertion(state);
        case 'empty':
          return compare(state, () => assert.equal(getLength(state.actual), 0, state.message));
        case 'equal':
          return (expected: unknown, message?: string) =>
            compare(state, () =>
              state.deep
                ? assert.deepEqual(state.actual, expected, message ?? state.message)
                : assert.equal(state.actual, expected, message ?? state.message),
            );
        case 'eql':
          return (expected: unknown, message?: string) =>
            compare(state, () => assert.deepEqual(state.actual, expected, message ?? state.message));
        case 'exist':
          return compare(state, () => assert.notEqual(state.actual, null, state.message));
        case 'false':
          return compare(state, () => assert.equal(state.actual, false, state.message));
        case 'fulfilled':
          return assertPromise(state, false);
        case 'greaterThan':
        case 'gt':
          return (expected: number | bigint, message?: string) =>
            compare(state, () => assert.ok((state.actual as number | bigint) > expected, message ?? state.message));
        case 'greaterThanOrEqual':
        case 'instanceOf':
        case 'instanceof':
          if (property === 'greaterThanOrEqual') {
            return (expected: number | bigint, message?: string) =>
              compare(state, () => assert.ok((state.actual as number | bigint) >= expected, message ?? state.message));
          }
          return (expected: abstract new (...args: never[]) => unknown) =>
            compare(state, () => assert.ok(state.actual instanceof expected, state.message));
        case 'keys':
          return (...expected: string[]) =>
            compare(state, () => assert.deepEqual(Object.keys(Object(state.actual)).sort(), expected.sort()));
        case 'least':
          return (expected: number | bigint, message?: string) =>
            compare(state, () => assert.ok((state.actual as number | bigint) >= expected, message ?? state.message));
        case 'length':
          return makeLengthAssertion(state);
        case 'lengthOf':
          return (expected: number, message?: string) =>
            compare(state, () => assert.equal(getLength(state.actual), expected, message ?? state.message));
        case 'lessThan':
        case 'lt':
          return (expected: number | bigint, message?: string) =>
            compare(state, () => assert.ok((state.actual as number | bigint) < expected, message ?? state.message));
        case 'lessThanOrEqual':
          return (expected: number | bigint, message?: string) =>
            compare(state, () => assert.ok((state.actual as number | bigint) <= expected, message ?? state.message));
        case 'match':
          return (expected: RegExp) => compare(state, () => assert.match(String(state.actual), expected));
        case 'members':
          return (expected: unknown[]) => compare(state, () => assertMembers(state.actual, expected));
        case 'most':
          return (expected: number | bigint) =>
            compare(state, () => assert.ok((state.actual as number | bigint) <= expected, state.message));
        case 'null':
          return compare(state, () => assert.equal(state.actual, null, state.message));
        case 'oneOf':
          return (expected: unknown[]) => compare(state, () => assert.ok(expected.includes(state.actual)));
        case 'property':
          return (name: string, ...expected: unknown[]) => {
            const value = propertyValue(state.actual, name);
            compare(state, () => {
              if (expected.length > 0) {
                assert.deepEqual(value, expected[0], state.message);
              }
            });
            return createAssertion({...state, actual: value, negate: false, deep: false});
          };
        case 'rejected':
          return assertPromise(state, true);
        case 'rejectedWith':
          return (...expected: Array<RegExp | string | (abstract new (...args: never[]) => Error)>) =>
            assertRejectedWith(state, expected);
        case 'satisfy':
          return (predicate: (actual: any) => boolean) =>
            compare(state, () => assert.ok(predicate(state.actual), state.message));
        case 'throw':
        case 'throws':
          return (...expected: Array<RegExp | string | (abstract new (...args: never[]) => Error)>) => {
            assert.equal(typeof state.actual, 'function', 'expected value to be a function');
            const fn = state.actual as () => unknown;
            const assertion = () => {
              assert.throws(fn, makeThrowMatcher(expected));
            };
            return compare(state, assertion);
          };
        case 'true':
          return compare(state, () => assert.equal(state.actual, true, state.message));
        case 'undefined':
          return compare(state, () => assert.equal(state.actual, undefined, state.message));
        default:
          return undefined;
      }
    },
  });

globalThis.after = (fn: HookFn) => nodeAfter(wrapHook(fn));
globalThis.afterEach = (fn: HookFn) => nodeAfterEach(wrapHook(fn));
globalThis.before = (fn: HookFn) => nodeBefore(wrapHook(fn));
globalThis.beforeEach = (fn: HookFn) => nodeBeforeEach(wrapHook(fn));
globalThis.describe = describeApi;
globalThis.expect = Object.assign(
  (actual: unknown, message?: string) => createAssertion({actual, deep: false, message, negate: false}),
  {
    fail(message?: string): never {
      assert.fail(message);
    },
  },
);
globalThis.it = itApi;

export {};
