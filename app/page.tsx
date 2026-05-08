import { ClientErrorBoundary } from "@/components/client-error-boundary";
import HomePage from "@/components/home-page";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function Page() {
  return (
    <ClientErrorBoundary>
      <HomePage />
    </ClientErrorBoundary>
  );
}
