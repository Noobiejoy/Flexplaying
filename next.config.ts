import type { NextConfig } from "next";

const SHARP_NATIVE = ["./node_modules/@img/sharp-linux-x64/**/*", "./node_modules/@img/sharp-libvips-linux-x64/**/*"];

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["sharp"],
  // sharp loads libvips from these platform packages at runtime; file tracing
  // does not discover the .so files on its own, so ship them explicitly.
  outputFileTracingIncludes: {
    "/*": SHARP_NATIVE,
    "/**/*": SHARP_NATIVE,
    "/api/cron/tick": SHARP_NATIVE,
  },
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
