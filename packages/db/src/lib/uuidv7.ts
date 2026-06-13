import { v7 as v7Native } from 'uuid';

/**
 * UUIDv7 generator — time-ordered, monotonic within a millisecond.
 * Used as the default for every primary key. Keeps b-tree inserts
 * append-friendly (much less page splitting than v4) while remaining
 * globally unique and resistant to enumeration.
 */
export function uuidv7(): string {
  return v7Native();
}
