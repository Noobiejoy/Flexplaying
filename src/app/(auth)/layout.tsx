import { PRODUCT_NAME } from "@/lib/product";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent)] text-lg font-bold text-white">E</div>
          <div className="text-lg font-semibold tracking-tight">{PRODUCT_NAME}</div>
          <div className="text-xs text-ink-3">Autonomous editorial desk</div>
        </div>
        <div className="glass rounded-3xl p-6">{children}</div>
      </div>
    </main>
  );
}
