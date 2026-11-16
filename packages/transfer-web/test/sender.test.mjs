// Reuse the encrypted sender contract against the package implementation.
process.env.CD_RESUME_SENDER_MODULE = '../packages/transfer-web/src/transport.js';
await import('../../../src/resume-sender.test.js');
