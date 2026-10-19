'use strict';
const { z } = require('zod');

/** Schémas zod partagés entre modules. */
const metadata = z
  .record(z.string().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 50, { message: '50 clés maximum.' });

module.exports = { metadata };
