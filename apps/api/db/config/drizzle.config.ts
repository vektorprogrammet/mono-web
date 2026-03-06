import "dotenv/config";
import { databaseUrl } from "@/db/config/parameters";
import { defineConfig } from "drizzle-kit";

// biome-ignore lint/style/noDefaultExport: this is needed for drizzle to work correctly
export default defineConfig({
	schema: "./db/tables/*",
	out: "./db/migrations",
	dialect: "postgresql",
	dbCredentials: { url: databaseUrl },
	verbose: true,
	strict: true,
});
