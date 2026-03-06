import { env } from "node:process";
import type { ConnectionOptions } from "node:tls";
import { hostingStringParser, toPortParser } from "@/lib/network-parsers";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";

function getCaCert(): string | Buffer | (string | Buffer)[] | undefined {
	return env.CA_CERT;
}

const sslOptionSchema = z
	.union([
		z.literal("prod").transform(() => {
			return {
				requestCert: true,
				rejectUnauthorized: true,
			} as ConnectionOptions;
		}),
		z.literal("prod-provide_ca_cert").transform((_, ctx) => {
			const caCert = getCaCert();
			if (caCert === undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Could not find ca certificate",
				});
				return z.NEVER;
			}
			return {
				requestCert: true,
				rejectUnauthorized: true,
				ca: caCert,
			} as ConnectionOptions;
		}),
		z.literal("dev").transform(() => {
			return {
				requestCert: true,
				rejectUnauthorized: false,
			} as ConnectionOptions;
		}),
		z.literal("true").transform(() => {
			return true;
		}),
		z.literal("false").transform(() => {
			return false;
		}),
	])
	.default("prod");

const urlSchema = z
	.object({
		DATABASE_URL: z.string().url(),
		DATABASE_SSL_OPTION: sslOptionSchema,
	})
	.transform((schema) => ({
		connectionString: schema.DATABASE_URL,
		ssl: schema.DATABASE_SSL_OPTION,
	}));

const individualSchema = z
	.object({
		DATABASE_HOST: hostingStringParser,
		DATABASE_NAME: z.string().nonempty(),
		DATABASE_USER: z.string().nonempty(),
		DATABASE_PASSWORD: z.string().nonempty(),
		DATABASE_PORT: toPortParser,
		DATABASE_SSL_OPTION: sslOptionSchema,
	})
	.transform((schema) => ({
		host: schema.DATABASE_HOST.trim(),
		database: schema.DATABASE_NAME.trim(),
		user: schema.DATABASE_USER.trim(),
		password: schema.DATABASE_PASSWORD.trim(),
		port: schema.DATABASE_PORT,
		ssl: schema.DATABASE_SSL_OPTION,
	}));

const parametersResult = urlSchema.or(individualSchema).safeParse(env);

if (!parametersResult.success) {
	console.error("Error when parsing enviroment variables.");
	console.error(
		"Provide DATABASE_URL or individual DATABASE_HOST/NAME/USER/PASSWORD/PORT vars.",
	);
	console.error(fromZodError(parametersResult.error).message);
	process.exit(1);
}

/** Connection parameters for pg.Client */
export const databaseConnectionParameters = parametersResult.data;

/** Connection URL for drizzle-kit (returns url string or constructs one from individual params) */
export const databaseUrl: string =
	"connectionString" in databaseConnectionParameters
		? databaseConnectionParameters.connectionString
		: `postgresql://${databaseConnectionParameters.user}:${databaseConnectionParameters.password}@${databaseConnectionParameters.host}:${databaseConnectionParameters.port}/${databaseConnectionParameters.database}`;

if (env.LOG_DATABASE_CREDENTIALS_ON_STARTUP === "true") {
	console.info("Database parameters:", databaseConnectionParameters);
}
