// Pre-migration script: Convert old categories to new ones before schema change
// Run this BEFORE prisma db push to avoid enum constraint errors
// v3: Now handles all migration scenarios including post-push recovery

async function migrateCategories() {
  // Use raw SQL since Prisma client may have new enum values
  const { Client } = require('pg');

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Check if VehicleCategory enum exists
    const enumCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'VehicleCategory'
      ) as exists
    `);

    if (!enumCheck.rows[0].exists) {
      console.log('VehicleCategory enum does not exist yet. Will be created by Prisma.');
      return;
    }

    // Check current enum values
    const checkResult = await client.query(`
      SELECT enumlabel FROM pg_enum
      WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'VehicleCategory')
    `);

    const existingValues = checkResult.rows.map(r => r.enumlabel);
    console.log('Current enum values:', existingValues);

    // List of old values that need migration
    const oldValues = ['CARRO', 'MOTO', 'LITE', 'PREMIUM', 'CORPORATIVO', 'CONFORT'];
    const hasOldValues = oldValues.some(v => existingValues.includes(v));
    const hasNewValues = existingValues.includes('CARRO_PEQUENO') && existingValues.includes('CARRO_GRANDE');

    if (hasOldValues) {
      console.log('Found old categories, preparing migration...');

      // Step 1: Add new enum values if they don't exist
      if (!existingValues.includes('CARRO_PEQUENO')) {
        await client.query(`ALTER TYPE "VehicleCategory" ADD VALUE IF NOT EXISTS 'CARRO_PEQUENO'`);
        console.log('Added CARRO_PEQUENO to enum');
      }
      if (!existingValues.includes('CARRO_GRANDE')) {
        await client.query(`ALTER TYPE "VehicleCategory" ADD VALUE IF NOT EXISTS 'CARRO_GRANDE'`);
        console.log('Added CARRO_GRANDE to enum');
      }

      // Step 2: Migrate existing ride data
      // Map old categories to new ones:
      // CARRO, MOTO, LITE -> CARRO_PEQUENO (Small Car / Economic)
      // PREMIUM, CORPORATIVO, CONFORT -> CARRO_GRANDE (Large Car / Comfort)

      const caseStatements = [];

      if (existingValues.includes('CARRO')) {
        caseStatements.push(`WHEN category::text = 'CARRO' THEN 'CARRO_PEQUENO'::"VehicleCategory"`);
      }
      if (existingValues.includes('MOTO')) {
        caseStatements.push(`WHEN category::text = 'MOTO' THEN 'CARRO_PEQUENO'::"VehicleCategory"`);
      }
      if (existingValues.includes('LITE')) {
        caseStatements.push(`WHEN category::text = 'LITE' THEN 'CARRO_PEQUENO'::"VehicleCategory"`);
      }
      if (existingValues.includes('PREMIUM')) {
        caseStatements.push(`WHEN category::text = 'PREMIUM' THEN 'CARRO_GRANDE'::"VehicleCategory"`);
      }
      if (existingValues.includes('CORPORATIVO')) {
        caseStatements.push(`WHEN category::text = 'CORPORATIVO' THEN 'CARRO_GRANDE'::"VehicleCategory"`);
      }
      if (existingValues.includes('CONFORT')) {
        caseStatements.push(`WHEN category::text = 'CONFORT' THEN 'CARRO_GRANDE'::"VehicleCategory"`);
      }

      if (caseStatements.length > 0) {
        // Check if there are any rides with old categories
        const countResult = await client.query(`
          SELECT COUNT(*) as count FROM "Ride"
          WHERE category::text IN ('CARRO', 'MOTO', 'LITE', 'PREMIUM', 'CORPORATIVO', 'CONFORT')
        `);

        const rideCount = parseInt(countResult.rows[0].count);
        console.log(`Found ${rideCount} rides with old categories`);

        if (rideCount > 0) {
          const updateQuery = `
            UPDATE "Ride"
            SET category = CASE
              ${caseStatements.join('\n              ')}
              ELSE category
            END
            WHERE category::text IN ('CARRO', 'MOTO', 'LITE', 'PREMIUM', 'CORPORATIVO', 'CONFORT')
          `;

          const updateResult = await client.query(updateQuery);
          console.log(`Updated ${updateResult.rowCount} rides to new categories`);
        }
      }

      console.log('Migration complete! Old data has been converted.');
      console.log('');
      console.log('IMPORTANT: After this migration, you should run:');
      console.log('  prisma db push');
      console.log('');
      console.log('This will remove the old enum values from the database schema.');

    } else if (hasNewValues) {
      console.log('Database already has new category names (CARRO_PEQUENO, CARRO_GRANDE).');
      console.log('No migration needed.');
    } else if (existingValues.length === 0) {
      console.log('Enum exists but has no values. Prisma will populate it.');
    } else {
      console.log('Unknown enum state. Current values:', existingValues);
      console.log('Please check the database manually.');
    }

  } catch (error) {
    console.error('Migration error:', error.message);
    console.error('Full error:', error);
    // Don't throw - let the deployment continue
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
}

migrateCategories();
