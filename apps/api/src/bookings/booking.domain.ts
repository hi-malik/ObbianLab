export type BookingStatus =
  | 'requested' | 'allocating' | 'offered' | 'confirmed'
  | 'in_progress' | 'completed' | 'cancelled' | 'unfulfilled';

const allowed: Record<BookingStatus, BookingStatus[]> = {
  requested: ['allocating', 'cancelled', 'unfulfilled'],
  allocating: ['offered', 'requested', 'cancelled', 'unfulfilled'],
  offered: ['confirmed', 'requested', 'cancelled', 'unfulfilled'],
  confirmed: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  unfulfilled: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return allowed[from].includes(to);
}

export function requireTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) throw new Error(`invalid booking transition: ${from} -> ${to}`);
}

export function isOfferAcceptable(status: string, expiresAt: Date, now: Date): boolean {
  return status === 'pending' && expiresAt.getTime() > now.getTime();
}
