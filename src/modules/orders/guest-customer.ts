/**
 * Guest checkout keeps every order attached to a real profile (orders,
 * coupons and idempotency all key on user_id), so each guest phone number
 * gets one hidden customer account with a synthetic, undeliverable email.
 * The guest never receives a session or password for it; the shop sees all
 * of a phone number's orders together.
 *
 * `.invalid` is reserved (RFC 2606) so the address can never receive mail,
 * and registration rejects it so nobody can claim a guest's order history.
 */
export const GUEST_EMAIL_DOMAIN = 'guest.dhakawholesale.invalid';

/** `phone` must already be normalised to 01XXXXXXXXX. */
export function guestEmailFor(phone: string): string {
  return `guest-${phone}@${GUEST_EMAIL_DOMAIN}`;
}

export function isGuestEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase().endsWith(`@${GUEST_EMAIL_DOMAIN}`);
}
