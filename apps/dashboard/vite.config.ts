import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    reactRouter(),
		tailwindcss(),
  ],
	resolve: {
		alias: {
			"@/components": "/app/components",
			"@/hooks": "/app/hooks",
			"@/lib": "/app/lib",
			"@/ui": "/app/components/ui",
		}
	}
});
