"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Notice } from "./ui";

/**
 * Supabase reports email-link failures in the URL fragment, which the server
 * never sees. Show them in plain words and clear the fragment.
 */
export function LinkError({ fromQuery }: { fromQuery: boolean }) {
  const [code, setCode] = useState<string | null>(fromQuery ? "link" : null);
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const c = hash.get("error_code") ?? hash.get("error");
    if (!c) return;
    // Read once from the fragment, which only exists in the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCode(c);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);
  if (!code) return null;
  return (
    <div className="mb-5">
      <Notice tone="bad" title={code === "otp_expired" ? "That link has expired or was already used" : "That link didn't work"}>
        Each email link works once and expires after an hour, and only the newest one you requested is valid. <Link href="/forgot-password" className="font-medium text-[var(--link)] underline">Request a new link</Link>, then open it once.
      </Notice>
    </div>
  );
}
