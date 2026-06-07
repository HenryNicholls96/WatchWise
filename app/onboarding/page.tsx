import { redirect } from "next/navigation";
import { DISCOVERY_PATH, getOnboardingState } from "@/lib/auth/onboarding-gate";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";

export default async function OnboardingPage() {
  // If a signed-in user already finished onboarding, don't make them do it again. Anyone else
  // (not done, or no session) gets the flow — so landing here directly always works.
  const { completed } = await getOnboardingState();
  if (completed === true) redirect(DISCOVERY_PATH);

  return (
    <main className="flex w-full flex-1 flex-col">
      <OnboardingFlow />
    </main>
  );
}
