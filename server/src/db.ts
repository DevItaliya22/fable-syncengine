import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

/**
 * `npx prisma dev` hands out a `prisma+postgres://localhost:...` URL whose
 * api_key embeds the real TCP connection string. The `pg` driver does not
 * understand that protocol (older adapter versions don't transform it),
 * so we extract the underlying `postgres://` URL ourselves when needed.
 */
function resolveConnectionString(url: string): string {
  if (!url.startsWith("prisma+postgres://")) return url;

  try {
    const parsed = new URL(url.replace("prisma+postgres://", "http://"));
    const isLocal =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const apiKey = parsed.searchParams.get("api_key");
    if (isLocal && apiKey) {
      const payload = JSON.parse(
        Buffer.from(apiKey, "base64url").toString("utf8"),
      ) as {
        databaseUrl?: string;
      };
      if (payload.databaseUrl) return payload.databaseUrl;
    }
  } catch {
    // fall through and let the adapter try the raw URL
  }
  return url;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set. Add it to server/.env");
}

const adapter = new PrismaPg({
  connectionString: resolveConnectionString(databaseUrl),
});

export const prisma = new PrismaClient({ adapter });
