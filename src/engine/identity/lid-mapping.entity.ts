import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Persisted `lid -> phone` resolution table on the `data` connection. One global, cross-session row per
 * lid (the maintainer wants the mapping shared, not per-session), so a lid resolved in one session/run is
 * usable everywhere and survives restarts - replacing the per-session, in-memory `lidToPn` map.
 *
 * A phone is last-write-wins: a stored mapping is "best known, not forever" (WhatsApp recycles numbers),
 * so it's a cache WhatsApp can correct. `phone` is nullable to record a negative result (a lid we looked
 * up and could not resolve) so active lookups stay one-network-call-per-unknown-lid. A negative replaces a
 * phone only when the session that wrote it (or none, or one since deleted) answers it, since another
 * account may not see the number. `sessionId` is the session that last wrote the row - intentionally NOT a
 * foreign key, since the row outlives any one session.
 */
@Entity('lid_mappings')
@Index(['phone']) // reverse lookup: phone -> lids, for the message from-filter
export class LidMapping {
  /** The lid number (bare, device-stripped - the user-part of `<lid>@lid`). */
  @PrimaryColumn()
  lid!: string;

  /** E.164 phone digits, or null when the lid is known-but-unresolved (a cached negative result). */
  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  /** The session that last wrote this row; a negative from another live session leaves its phone. Not a foreign key. */
  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
