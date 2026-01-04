// Pre-migration script: Convert old categories to new ones before schema change
// Run this BEFORE prisma db push to avoid enum constraint errors

const { PrismaClient } = require('@prisma/client');

async function migrateCategories() {
  // Use raw SQL since Prisma client may have new enum values
  const { Client } = require('pg');

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Check if old enum values exist
    const checkResult = await client.query(`
      SELECT enumlabel FROM pg_enum
      WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'VehicleCategory')
    `);

    const existingValues = checkResult.rows.map(r => r.enumlabel);
    console.log('Current enum values:', existingValues);

    // If old values exist, migrate the data
    if (existingValues.includes('CARRO') || existingValues.includes('MOTO')) {
      console.log('Migrating old categories to new ones...');

      // First, add new enum values if they don't exist
      if (!existingValues.includes('LITE')) {
        await client.query(`ALTER TYPE "VehicleCategory" ADD VALUE IF NOT EXISTS 'LITE'`);
        console.log('Added LITE to enum');
      }
      if (!existingValues.includes('CONFORT')) {
        await client.query(`ALTER TYPE "VehicleCategory" ADD VALUE IF NOT EXISTS 'CONFORT'`);
        console.log('Added CONFORT to enum');
      }

      // Update existing rides: CARRO/MOTO -> LITE, PREMIUM/CORPORATIVO -> CONFORT
      const updateResult = await client.query(`
        UPDATE "Ride"
        SET category = CASE
          WHEN category::text IN ('CARRO', 'MOTO') THEN 'LITE'::"VehicleCategory"
          WHEN category::text IN ('PREMIUM', 'CORPORATIVO') THEN 'CONFORT'::"VehicleCategory"
          ELSE category
        END
        WHERE category::text IN ('CARRO', 'MOTO', 'PREMIUM', 'CORPORATIVO')
      `);
      console.log(`Updated ${updateResult.rowCount} rides`);

      console.log('Migration complete! Old data has been converted.');
    } else {
      console.log('No old categories found, skipping migration');
    }

  } catch (error) {
    console.error('Migration error:', error.message);
    // Don't throw - let the deployment continue
  } finally {
    await client.end();
  }
}

migrateCategories();
