import { authClient } from "../auth";
/** Close owner-scoped local UI immediately on sign-out/account changes. */
export function watchOwner(owner: string, invalidate: () => void) {
  const auth = authClient();
  if (!auth) return () => {};
  const { data } = auth.auth.onAuthStateChange((_event, session) => {
    if (session?.user.id !== owner) invalidate();
  });
  return () => data.subscription.unsubscribe();
}
