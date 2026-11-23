export function isDemoMode(): boolean {
  return (
    process.env.NEXT_PUBLIC_BUNKO_DEMO === 'true' || process.env.BUNKO_DEMO_MODE === 'true'
  );
}
