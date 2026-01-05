// Pre-migration script: Convert old categories to new ones before schema change
// Run this BEFORE prisma db push to avoid enum constraint errors
// v2: Now migrates LITE/CONFORT to CARRO_PEQUENO/CARRO_GRANDE

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

    // Check for old values and add new ones if needed
    if (existingValues.includes('CARRO') || existingValues.includes('MOTO') ||
        existingValues.includes('LITE') || existingValues.includes('CONFORT')) {

      console.log('Found old categories, preparing migration...');

      // Add new enum values if they don't exist
      if (!existingValues.includes('CARRO_PEQUENO')) {
        await client.query(`ALTER TYPE "VehicleCategory" ADD VALUE IF NOT EXISTS 'CARRO_PEQUENO'`);
        console.log('Added CARRO_PEQUENO to enum');
      }
      if (!existingValues.includes('CARRO_GRANDE')) {
        await client.query(`ALTER TYPE "VehicleCategory" ADD VALUE IF NOT EXISTS 'CARRO_GRANDE'`);
        console.log('Added CARRO_GRANDE to enum');
      }

      // Build dynamic update query based on what exists
      let caseStatements = [];

      // Map old categories to new ones:
      // CARRO, MOTO, LITE -> CARRO_PEQUENO (Small Car / Economic)
      // PREMIUM, CORPORATIVO, CONFORT -> CARRO_GRANDE (Large Car / Comfort)

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
        const updateQuery = `
          UPDATE "Ride"
          SET category = CASE
            ${caseStatements.join('\n            ')}
            ELSE category
          END
          WHERE category::text IN ('CARRO', 'MOTO', 'LITE', 'PREMIUM', 'CORPORATIVO', 'CONFORT')
        `;

        const updateResult = await client.query(updateQuery);
        console.log(`Updated ${updateResult.rowCount} rides`);
      }

      console.log('Migration complete! Old data has been converted.');
    } else if (existingValues.includes('CARRO_PEQUENO') && existingValues.includes('CARRO_GRANDE')) {
      console.log('Database already has new category names, no migration needed');
    } else {
      console.log('No categories found to migrate');
    }

  } catch (error) {
    console.error('Migration error:', error.message);
    // Don't throw - let the deployment continue
  } finally {
    await client.end();
  }
}

migrateCategories();
