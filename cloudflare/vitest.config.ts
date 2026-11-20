import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      TEST_MIGRATIONS: migrations,
      ADMIN_USERNAME: "test-admin",
      ADMIN_PASSWORD: "test-admin-password-at-least-12-characters",
      ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    } }
  })],
  test: { include: ["tests/**/*.test.ts"] }
});
