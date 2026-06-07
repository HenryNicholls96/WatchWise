import { redirect } from "next/navigation";
import { ONBOARDING_PATH, getOnboardingState } from "@/lib/auth/onboarding-gate";
import { DiscoveryView } from "@/components/discovery/DiscoveryView";
import { TasteTunedBanner } from "@/components/discovery/TasteTunedBanner";

export default async function Home() {
  // Gate: a signed-in user who hasn't finished onboarding goes there first. A no-session visitor
  // (completed === null) browses freely — never redirected here, which keeps the flow loop-safe.
  // To auto-onboard brand-new visitors later, bootstrap an anonymous session before this gate
  // (see EXTENSION POINT in lib/auth/onboarding-gate.ts); no change needed in this file.
  const { completed } = await getOnboardingState();
  if (completed === false) redirect(ONBOARDING_PATH);

  return (
    <main className="relative flex flex-1 flex-col items-center px-4 py-14 sm:py-24">
      {/* Soft, calm backdrop for a more premium feel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-gradient-to-b from-accent/60 via-background to-background"
      />

      <header className="mb-10 flex w-full max-w-5xl flex-col gap-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          WatchWise
        </p>
        <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
          No More Scrolling
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          Type in whatever you want &mdash; we&rsquo;ll find you a gem
        </p>
      </header>

      {/* One-time post-onboarding reassurance — sits below the header, above the primary content.
          Renders nothing unless the user just finished onboarding. */}
      <TasteTunedBanner />

      <DiscoveryView />
    </main>
  );
}
