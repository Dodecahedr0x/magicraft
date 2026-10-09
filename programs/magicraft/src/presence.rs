//! `ChunkPresence` list maintenance for `move_player` (layout: `state.rs`).
//!
//! # Economics (design doc, "Presence economics")
//! Every entry is 56 bytes of ephemeral rent (`56 × 32` = 1 792 lamports) and every resize
//! goes through `EphemeralAccount::resize` with **the mover's Player as sponsor**: growing
//! charges it, shrinking refunds it. So:
//! - entering a chunk (or re-entering after being pruned) costs the mover one entry;
//! - leaving a chunk (border crossing) refunds the mover one entry: a crossing nets to 0;
//! - pruning stale entries (other players' `last_seen_ms` older than [`STALE_MS`] of chain
//!   time, at most [`MAX_PRUNE`] per call; an entry with `pending_damage > 0` only after
//!   [`DAMAGED_STALE_MS`], so its owner can't dodge damage by pausing a few seconds, yet an
//!   abandoned damaged entry can't block `close_chunk` forever) refunds **the pruner**
//!   (the mover), not the
//!   entry's original payer. The vault does not track who paid an entry, and this is the
//!   designed incentive (a player who quits leaves ≤ 1 792 lamports behind, collected by
//!   whoever moves through that chunk next).
//!
//! The header (48 B) is paid by the chunk's payer at `create_chunk` and refunded by
//! `close_chunk`, which requires an empty list.
//!
//! # Order of operations
//! The list is unordered (swap-remove). In one call: prune ≤ 4 stale entries (never the
//! mover's own), then update the mover's entry or insert it — into a slot freed by pruning
//! if there is one, else by growing the account by one entry. Net effect on the length is
//! one resize CPI at most (none when the mover is already listed and nothing is stale).

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::ephemeral_accounts::{rent, EphemeralAccount};

use crate::errors::MagicraftError;
use crate::state::{
    ensure_sponsor_reserve, presence_len, presence_of, LeI32, LeI64, PresenceEntry, PresenceHeader,
    PRESENCE_ENTRY_SIZE, PRESENCE_HEADER_SIZE,
};

/// Entries whose `last_seen_ms` is older than this (chain ms) are ignored by mobs and
/// pruned by movers.
pub const STALE_MS: i64 = 5_000;
/// Entries with `pending_damage > 0` are pruned only after this long (chain ms).
pub const DAMAGED_STALE_MS: i64 = 60_000;
/// At most this many stale entries are pruned per call (bounds CU).
pub const MAX_PRUNE: usize = 4;
/// Rent of one entry, lamports.
pub const ENTRY_RENT: u64 = rent(PRESENCE_ENTRY_SIZE as u32) - rent(0);

const _: () = assert!(ENTRY_RENT == 56 * 32);

/// Outcome of [`upsert`] on a list of `n` entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Upsert {
    /// Valid entries after the call (`entries[..count]`), not counting an entry that still
    /// needs a slot (`grow`).
    pub count: usize,
    /// The mover's entry is not in `entries[..count]`: grow by one and write
    /// [`new_entry`] at index `count`.
    pub grow: bool,
    /// `pending_damage` taken from the mover's existing entry (0 if it had none).
    pub pending: u8,
    /// Stale entries removed.
    pub pruned: usize,
}

/// A fresh entry for `me` at `pos`, seen at `now`.
pub fn new_entry(me: &Pubkey, pos: [i32; 3], now: i64) -> PresenceEntry {
    PresenceEntry {
        player: *me,
        pos: pos.map(LeI32::new),
        last_seen_ms: LeI64::new(now),
        pending_damage: 0,
        _pad: [0; 3],
    }
}

/// Pure list step (see the module docs): prunes up to [`MAX_PRUNE`] entries of other
/// players with `now − last_seen_ms > STALE_MS` ([`DAMAGED_STALE_MS`] with pending damage)
/// (swap-remove), then updates `me`'s entry
/// (position, `last_seen_ms = now`, takes and zeroes `pending_damage`) or inserts it into a
/// freed slot; if no slot is free, reports `grow`. Pending damage of an own entry last seen
/// before `since` (the player's last respawn) is dropped, not taken: it hit the dead body.
pub fn upsert(
    entries: &mut [PresenceEntry],
    me: &Pubkey,
    pos: [i32; 3],
    now: i64,
    since: i64,
) -> Upsert {
    let n = entries.len();
    let mut own = None;
    let mut stale = [0usize; MAX_PRUNE];
    let mut ns = 0;
    for (i, e) in entries.iter().enumerate() {
        if e.player == *me {
            own = Some(i);
        } else if ns < MAX_PRUNE
            && now.saturating_sub(e.last_seen_ms.get())
                > if e.pending_damage == 0 {
                    STALE_MS
                } else {
                    DAMAGED_STALE_MS
                }
        {
            stale[ns] = i;
            ns += 1;
        }
    }
    // Swap-remove in descending index order: every stale index above the current one is
    // already gone, so the current last element is never a pending stale entry.
    let mut last = n;
    for &i in stale[..ns].iter().rev() {
        last -= 1;
        entries[i] = entries[last];
        if own == Some(last) {
            own = Some(i);
        }
    }
    let mut count = last;
    let mut pending = 0;
    let mut grow = false;
    match own {
        Some(i) => {
            let e = &mut entries[i];
            if e.last_seen_ms.get() >= since {
                pending = e.pending_damage;
            }
            e.pending_damage = 0;
            e.pos = pos.map(LeI32::new);
            e.last_seen_ms.set(now);
        }
        None if count < n => {
            entries[count] = new_entry(me, pos, now);
            count += 1;
        }
        None => grow = true,
    }
    Upsert {
        count,
        grow,
        pending,
        pruned: ns,
    }
}

/// Pure: removes `me`'s entry (swap-remove). Returns the new count and its
/// `pending_damage` (0 if the entry was last seen before `since`, as in [`upsert`]), or
/// `None` if `me` is not listed.
pub fn remove(entries: &mut [PresenceEntry], me: &Pubkey, since: i64) -> Option<(usize, u8)> {
    let i = entries.iter().position(|e| e.player == *me)?;
    let e = &entries[i];
    let pending = if e.last_seen_ms.get() >= since {
        e.pending_damage
    } else {
        0
    };
    let last = entries.len() - 1;
    entries[i] = entries[last];
    Some((last, pending))
}

/// The accounts a presence resize needs: sponsor (the mover's Player, signing with
/// `seeds`) and the rent vault.
pub struct Sponsor<'a, 'info> {
    pub player: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
    pub seeds: &'a [&'a [u8]],
}

impl<'info> Sponsor<'_, 'info> {
    fn resize(&self, presence: &AccountInfo<'info>, len: usize) -> Result<()> {
        EphemeralAccount::new(self.player, presence, self.vault)
            .with_signer_seeds(&[self.seeds])
            .resize(len as u32)?;
        Ok(())
    }
}

/// [`upsert`] on the presence account of `chunk` (validated by [`presence_of`]), then at
/// most one resize: grow by one entry (sponsor pays, reserve checked) or shrink by the net
/// number of freed slots (sponsor refunded). Returns the mover's taken `pending_damage`.
pub fn enter_or_update<'info>(
    presence: &AccountInfo<'info>,
    chunk: &Pubkey,
    me: &Pubkey,
    pos: [i32; 3],
    now: i64,
    since: i64,
    sponsor: &Sponsor<'_, 'info>,
) -> Result<u8> {
    let (n, r) = {
        let (mut h, mut e) = presence_of(presence, chunk)?;
        let n = e.len();
        let r = upsert(&mut e, me, pos, now, since);
        if !r.grow {
            h.count.set(r.count as u16);
        }
        (n, r)
    };
    if r.grow {
        let new_count = u16::try_from(n + 1).map_err(|_| error!(MagicraftError::Overflow))?;
        ensure_sponsor_reserve(sponsor.player, ENTRY_RENT)?;
        sponsor.resize(presence, presence_len(n + 1))?;
        // The list is consistent again only once count is bumped; write it directly.
        let mut d = presence.try_borrow_mut_data()?;
        let o = presence_len(n);
        d[o..o + PRESENCE_ENTRY_SIZE].copy_from_slice(bytemuck::bytes_of(&new_entry(me, pos, now)));
        bytemuck::from_bytes_mut::<PresenceHeader>(&mut d[..PRESENCE_HEADER_SIZE])
            .count
            .set(new_count);
    } else if r.count < n {
        sponsor.resize(presence, presence_len(r.count))?;
    }
    Ok(r.pending)
}

/// Removes `me` from the presence account of `chunk` (if listed) and shrinks it by one
/// entry (sponsor refunded). Returns the entry's `pending_damage` (0 if not listed).
pub fn leave<'info>(
    presence: &AccountInfo<'info>,
    chunk: &Pubkey,
    me: &Pubkey,
    since: i64,
    sponsor: &Sponsor<'_, 'info>,
) -> Result<u8> {
    let removed = {
        let (mut h, mut e) = presence_of(presence, chunk)?;
        let r = remove(&mut e, me, since);
        if let Some((count, _)) = r {
            h.count.set(count as u16);
        }
        r
    };
    match removed {
        Some((count, pending)) => {
            sponsor.resize(presence, presence_len(count))?;
            Ok(pending)
        }
        None => Ok(0),
    }
}

const _: () = assert!(PRESENCE_HEADER_SIZE == 48);

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(k: u8, seen: i64, dmg: u8) -> PresenceEntry {
        let mut e = new_entry(&Pubkey::new_from_array([k; 32]), [k as i32; 3], seen);
        e.pending_damage = dmg;
        e
    }

    fn keys(e: &[PresenceEntry]) -> Vec<u8> {
        let mut v: Vec<u8> = e.iter().map(|e| e.player.to_bytes()[0]).collect();
        v.sort();
        v
    }

    #[test]
    fn update_own_takes_pending_damage() {
        let me = Pubkey::new_from_array([1; 32]);
        let mut l = vec![entry(2, 9_000, 0), entry(1, 1_000, 7)];
        let r = upsert(&mut l, &me, [5, 6, 7], 10_000, i64::MIN);
        assert_eq!(
            r,
            Upsert {
                count: 2,
                grow: false,
                pending: 7,
                pruned: 0
            }
        );
        // Own stale entry is never pruned; it is refreshed.
        assert_eq!(l[1].pending_damage, 0);
        assert_eq!(l[1].last_seen_ms.get(), 10_000);
        assert_eq!(l[1].pos.map(|v| v.get()), [5, 6, 7]);
    }

    #[test]
    fn insert_grows_when_nothing_is_freed() {
        let me = Pubkey::new_from_array([1; 32]);
        let mut l = vec![entry(2, 9_000, 0)];
        let r = upsert(&mut l, &me, [0; 3], 10_000, i64::MIN);
        assert_eq!((r.count, r.grow, r.pruned), (1, true, 0));
        let mut empty: Vec<PresenceEntry> = vec![];
        assert!(upsert(&mut empty, &me, [0; 3], 0, i64::MIN).grow);
    }

    #[test]
    fn prune_frees_a_slot_for_the_mover() {
        let me = Pubkey::new_from_array([1; 32]);
        // 5 000 ms old is still fresh; 5 001 is stale.
        let mut l = vec![entry(2, 5_000, 3), entry(3, 4_999, 0), entry(4, 9_000, 0)];
        let r = upsert(&mut l, &me, [0; 3], 10_000, i64::MIN);
        assert_eq!((r.count, r.grow, r.pruned, r.pending), (3, false, 1, 0));
        assert_eq!(keys(&l[..3]), vec![1, 2, 4]);
    }

    #[test]
    fn prune_at_most_four_and_track_own_index() {
        let me = Pubkey::new_from_array([1; 32]);
        let mut l: Vec<_> = (2..8).map(|k| entry(k, 0, 0)).collect(); // 6 stale
        l.push(entry(1, 0, 9)); // own entry last: moves when swapped
        let r = upsert(&mut l, &me, [1; 3], 100_000, i64::MIN);
        assert_eq!((r.count, r.grow, r.pruned, r.pending), (3, false, 4, 9));
        assert_eq!(keys(&l[..3]), vec![1, 6, 7]);
        let own = l[..3].iter().find(|e| e.player == me).unwrap();
        assert_eq!(own.last_seen_ms.get(), 100_000);
        // Next call prunes the remaining two.
        let mut l2 = l[..3].to_vec();
        let r = upsert(&mut l2, &me, [1; 3], 100_001, i64::MIN);
        assert_eq!((r.count, r.pruned), (1, 2));
        assert_eq!(keys(&l2[..1]), vec![1]);
    }

    #[test]
    fn damaged_entries_use_the_long_timeout() {
        let me = Pubkey::new_from_array([1; 32]);
        // At 60 s: the plain entry (> 5 s) goes, the damaged one (not > 60 s) stays.
        let mut l = vec![entry(2, 0, 3), entry(3, 0, 0)];
        let r = upsert(&mut l, &me, [0; 3], 60_000, i64::MIN);
        assert_eq!((r.count, r.pruned, r.grow), (2, 1, false));
        assert_eq!(keys(&l[..2]), vec![1, 2]);
        // The owner collects it on its own move.
        let owner = Pubkey::new_from_array([2; 32]);
        assert_eq!(
            upsert(&mut l[..2], &owner, [0; 3], 60_001, i64::MIN).pending,
            3
        );
        // An abandoned damaged entry is pruned after 60 s.
        let mut l = vec![entry(2, 0, 3)];
        let r = upsert(&mut l, &me, [0; 3], 60_001, i64::MIN);
        assert_eq!((r.count, r.pruned, r.grow), (1, 1, false));
        assert_eq!(keys(&l[..1]), vec![1]);
    }

    #[test]
    fn stale_check_is_total() {
        let me = Pubkey::new_from_array([1; 32]);
        let mut l = vec![entry(2, i64::MIN, 0), entry(3, i64::MAX, 0)];
        let r = upsert(&mut l, &me, [0; 3], i64::MAX, i64::MIN);
        assert_eq!((r.count, r.pruned), (2, 1));
        let r = upsert(&mut l[..2], &me, [0; 3], i64::MIN, i64::MIN);
        assert_eq!(r.pruned, 0);
    }

    #[test]
    fn pending_from_before_respawn_is_dropped() {
        let me = Pubkey::new_from_array([1; 32]);
        // Own entry last seen at 1 000 with 7 damage; respawned at 2 000.
        let mut l = vec![entry(1, 1_000, 7)];
        let r = upsert(&mut l, &me, [0; 3], 3_000, 2_000);
        assert_eq!((r.pending, l[0].pending_damage), (0, 0));
        // Damage taken after the respawn (entry seen since) counts.
        l[0].pending_damage = 4;
        assert_eq!(upsert(&mut l, &me, [0; 3], 4_000, 2_000).pending, 4);
        let mut l = vec![entry(1, 1_000, 7), entry(2, 0, 0)];
        assert_eq!(remove(&mut l, &me, 2_000), Some((1, 0)));
        let mut l = vec![entry(1, 2_000, 7)];
        assert_eq!(remove(&mut l, &me, 2_000), Some((0, 7)));
    }

    #[test]
    fn remove_swaps_last_in() {
        let me = Pubkey::new_from_array([1; 32]);
        let mut l = vec![entry(1, 0, 4), entry(2, 0, 0), entry(3, 0, 0)];
        assert_eq!(remove(&mut l, &me, i64::MIN), Some((2, 4)));
        assert_eq!(keys(&l[..2]), vec![2, 3]);
        assert_eq!(remove(&mut l[..2], &me, i64::MIN), None);
        let mut empty: Vec<PresenceEntry> = vec![];
        assert_eq!(remove(&mut empty, &me, i64::MIN), None);
    }
}
