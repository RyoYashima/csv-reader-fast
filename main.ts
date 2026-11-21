// The harness runs node /bot/main.ts; the driver is plain JavaScript (driver.mjs), which Node loads without stripping
// types, and that costs less CPU than a TypeScript driver.
import './driver.mjs';
