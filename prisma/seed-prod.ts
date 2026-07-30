import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/http/routes/admin.js';

const db = new PrismaClient();

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  const hmacSecret = process.argv[4];
  const restaurantName = process.argv[5] || 'My Restaurant';
  const restaurantSlug = process.argv[6] || 'my-restaurant';

  if (!email || !password || !hmacSecret) {
    console.error(
      'Usage: tsx prisma/seed-prod.ts <email> <password> <hmacSecret> [restaurantName] [restaurantSlug]'
    );
    console.error(
      'Please provide an email, a secure password, and a secure HMAC secret.'
    );
    process.exit(1);
  }

  console.log(`Creating production data for restaurant: ${restaurantName}`);

  try {
    const existingUser = await db.adminUser.findFirst({ where: { email } });
    if (existingUser) {
      console.log(
        `Admin user with email ${email} already exists. Halting script.`
      );
      return;
    }

    let restaurant = await db.restaurant.findUnique({
      where: { slug: restaurantSlug },
    });

    if (!restaurant) {
      console.log(`Creating restaurant "${restaurantName}"...`);
      restaurant = await db.restaurant.create({
        data: {
          name: restaurantName,
          slug: restaurantSlug,
          timezone: 'Europe/London', // TODO: Configure this
          phone: '+440000000000', // TODO: Configure this
          largePartyThreshold: 8,
          defaultTurnTimes: {
            default: 90,
            '1': 60,
            '2': 90,
            '5': 120,
            '8': 150,
          },
          bookingWindowDays: 90,
          flexibilityMinutes: 60,
          cancellationPolicy: 'Please provide a cancellation policy.',
          hmacSecret: hmacSecret,
        },
      });
      console.log(
        `Restaurant "${restaurantName}" created with ID: ${restaurant.id}`
      );
    } else {
      console.log(
        `Restaurant with slug "${restaurantSlug}" already exists. Using it.`
      );
    }

    console.log(`Creating admin user ${email}...`);
    const adminUser = await db.adminUser.create({
      data: {
        restaurantId: restaurant.id,
        email: email,
        passwordHash: hashPassword(password),
        role: 'owner',
      },
    });
    console.log(`Admin user ${adminUser.email} created successfully.`);
  } catch (error) {
    console.error('Production seeding failed:', error);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main();
