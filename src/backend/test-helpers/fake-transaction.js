/**
 * A fake Sequelize transaction, for testing multi-step writes without a database.
 *
 * Every controller that writes more than one row wraps the work in a
 * transaction, and the failure modes live in the ORDER of commit, rollback and
 * the work that follows them — not in the SQL. Those are exactly the paths a
 * database-backed test exercises badly and a unit test exercises well, and they
 * are where the real bug was: `mergeRows` committed, then ran a non-critical
 * re-validation that could throw, and the catch called `rollback()` on an
 * already-committed transaction. Sequelize rejects that, the rejection escaped
 * before `next(error)` ran, Express 4 does not forward an async rejection — and
 * a merge that had SUCCEEDED left the client waiting forever.
 *
 * A test can only catch that by asserting on the sequence, so this records one.
 *
 * @example
 *   const tx = fakeTransaction(t);          // patches sequelize.transaction
 *   await call(controller.mergeRows, req);
 *   assert.deepEqual(tx.calls, ['commit']);
 *   assert.equal(tx.rolledBack, false);
 */

'use strict';

const { sequelize } = require('../models');

/**
 * Patch `sequelize.transaction()` to hand out a recording fake.
 *
 * Supports both shapes the codebase uses: the managed form
 * (`sequelize.transaction(async (t) => …)`, which commits for you) and the
 * unmanaged form (`const t = await sequelize.transaction()`, which does not).
 *
 * @param {object} t - the node:test context, for `t.mock.method`
 * @param {{failCommit?: Error, failRollback?: Error}} [opts]
 * @returns {{calls: string[], committed: boolean, rolledBack: boolean, transaction: object}}
 */
function fakeTransaction(t, { failCommit = null, failRollback = null } = {}) {
  const state = {
    /** commit/rollback in the order they were called — the whole point. */
    calls: [],
    committed: false,
    rolledBack: false,
    transaction: null
  };

  const transaction = {
    id: 'fake-tx',
    LOCK: { UPDATE: 'UPDATE' },
    async commit() {
      state.calls.push('commit');
      // Sequelize rejects a second finish, and so must this: a fake more
      // forgiving than the real thing quietly passes the tests that matter.
      if (state.committed || state.rolledBack) {
        throw new Error('Transaction cannot be committed because it has been finished with state: '
          + (state.committed ? 'commit' : 'rollback'));
      }
      if (failCommit) throw failCommit;
      state.committed = true;
    },
    async rollback() {
      state.calls.push('rollback');
      // THE mechanism of the merge bug: rolling back an already-committed
      // transaction. Sequelize rejects; the rejection escaped before
      // next(error) ran; Express 4 does not forward an async rejection; the
      // client waited forever on a merge that had succeeded. A fake that
      // shrugged here would let that exact regression back in — it did, until
      // a mutation test showed the fake was the thing at fault.
      if (state.committed || state.rolledBack) {
        throw new Error('Transaction cannot be rolled back because it has been finished with state: '
          + (state.committed ? 'commit' : 'rollback'));
      }
      if (failRollback) throw failRollback;
      state.rolledBack = true;
    }
  };
  state.transaction = transaction;

  t.mock.method(sequelize, 'transaction', async (fn) => {
    // Managed form: run the callback, then commit or roll back around it, the
    // way Sequelize does — otherwise a test of managed code proves nothing
    // about what happens when the callback throws.
    if (typeof fn === 'function') {
      try {
        const result = await fn(transaction);
        await transaction.commit();
        return result;
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    }
    // Unmanaged form: the caller drives it.
    return transaction;
  });

  return state;
}

/**
 * Run a controller and capture whichever of res/next it reached.
 *
 * Resolves rather than throwing, so a test can assert on the error a handler
 * passed to `next` as easily as on the body it sent.
 *
 * @param {Function} handler
 * @param {object} req
 * @returns {Promise<{body: any, error: Error|null, statusCode: number}>}
 */
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    // A handler that neither responds nor calls next() is the failure this
    // whole file exists for. Without a timeout the test would hang exactly as
    // the client did, and report nothing.
    const timer = setTimeout(
      () => reject(new Error('the handler neither responded nor called next() — the client would hang')),
      2000
    );
    const done = (value) => { clearTimeout(timer); resolve(value); };

    const res = {
      statusCode: 200,
      json: (body) => done({ body, error: null, statusCode: res.statusCode }),
      status(code) { this.statusCode = code; return this; }
    };
    Promise.resolve(handler({ params: {}, body: {}, query: {}, ...req }, res,
      (error) => done({ body: null, error: error || null, statusCode: res.statusCode })))
      .catch((error) => done({ body: null, error, statusCode: res.statusCode, unhandled: true }));
  });
}

module.exports = { fakeTransaction, callController };
