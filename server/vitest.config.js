'use strict';
const { defineConfig } = require('vitest/config');

// Chaque fichier de test crée sa propre app sur une base ':memory:' :
// aucun état partagé, mais on garde un seul worker à la fois pour des logs lisibles.
module.exports = defineConfig({
  test: {
    environment: 'node',
    // Vitest 5 ne peut pas être require() depuis un fichier CommonJS : describe/it/expect sont globaux.
    globals: true,
    include: ['test/**/*.test.js'],
    fileParallelism: false,
    testTimeout: 10000,
  },
});
