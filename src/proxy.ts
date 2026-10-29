import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { canonicalRedirect, strayAuthCode } from "@/lib/canonical";

const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/auth", "/setup", "/api/cron", "/api/health"];

/** Refreshes the Supabase session cookie and redirects anonymous users to /login. */
export async function proxy(request: NextRequest) {
  const canonical = canonicalRedirect(request.nextUrl, request.headers.get("host"), process.env.APP_BASE_URL, process.env.VERCEL_ENV);
  if (canonical) return NextResponse.redirect(canonical, 308);
  const authCode = strayAuthCode(request.nextUrl);
  if (authCode) return NextResponse.redirect(authCode);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const path = request.nextUrl.pathname;
  if (!url || !key) {
    if (path === "/setup" || path.startsWith("/api/")) return NextResponse.next();
    return NextResponse.redirect(new URL("/setup", request.url));
  }
  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(toSet) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getUser();
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  if (!data.user && !isPublic) {
    const to = new URL("/login", request.url);
    if (path !== "/") to.searchParams.set("next", path);
    return NextResponse.redirect(to);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|jpeg|svg|webp)$).*)"],
};
