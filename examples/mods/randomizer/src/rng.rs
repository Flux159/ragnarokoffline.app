//! A seeded random number generator, so a seed is a promise.
//!
//! The whole point of a randomizer is that "seed 4815162342" means the same
//! world on your machine as on mine. That rules out anything that reaches for
//! the system entropy source, and it rules out `HashMap` iteration order --
//! both of which are the obvious way to shuffle a list in Rust and both of
//! which are different on every run.
//!
//! xoshiro256++ over a splitmix64-expanded seed. Both are a handful of lines,
//! both are specified by their authors as exact integer operations, and the
//! sequence is therefore identical on every platform this ships to. This is
//! not cryptography and does not pretend to be.

pub struct Rng {
    s: [u64; 4],
}

impl Rng {
    /// Expand a single seed into the four words the generator needs.
    ///
    /// splitmix64 is used for exactly this in the reference implementation:
    /// seeding xoshiro directly from a small number leaves most of its state
    /// zero, and a state that is nearly all zeroes takes a long time to
    /// scramble -- so seed 1 and seed 2 would produce visibly similar worlds.
    pub fn new(seed: u64) -> Rng {
        let mut x = seed;
        let mut next = || {
            x = x.wrapping_add(0x9E3779B97F4A7C15);
            let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            z ^ (z >> 31)
        };
        Rng { s: [next(), next(), next(), next()] }
    }

    pub fn next_u64(&mut self) -> u64 {
        let r = self.s[0].wrapping_add(self.s[3]).rotate_left(23).wrapping_add(self.s[0]);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        r
    }

    /// A number in `0..n`, without the modulo bias that `next_u64() % n` has.
    ///
    /// The bias is small for small `n` and it would never be noticed here, but
    /// rejection sampling is four lines and means the shuffle below is a real
    /// uniform permutation rather than one that very slightly prefers low
    /// indices.
    pub fn below(&mut self, n: u64) -> u64 {
        if n <= 1 {
            return 0;
        }
        let zone = u64::MAX - (u64::MAX % n) - 1;
        loop {
            let v = self.next_u64();
            if v <= zone {
                return v % n;
            }
        }
    }

    /// Fisher-Yates, in place.
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        if items.len() < 2 {
            return;
        }
        for i in (1..items.len()).rev() {
            let j = self.below(i as u64 + 1) as usize;
            items.swap(i, j);
        }
    }
}

/// Turn a seed the player typed into a number.
///
/// A bare number is itself, so `--seed 12345` is the number 12345 and reads
/// the same in the mod's name. Anything else is hashed, so `--seed
/// "tuesday night"` works and is still reproducible.
pub fn parse_seed(s: &str) -> u64 {
    if let Ok(n) = s.trim().parse::<u64>() {
        return n;
    }
    // FNV-1a: stable, specified, and not the standard library's hasher, which
    // is randomly keyed per process and would make a text seed mean something
    // different on every run.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property the whole tool rests on.
    #[test]
    fn the_same_seed_gives_the_same_shuffle() {
        let run = |seed| {
            let mut r = Rng::new(seed);
            let mut v: Vec<u32> = (0..64).collect();
            r.shuffle(&mut v);
            v
        };
        assert_eq!(run(99), run(99));
        assert_ne!(run(99), run(100));
    }

    /// Nearby seeds must not give nearby worlds -- the reason splitmix64 is
    /// in front of the generator at all.
    #[test]
    fn adjacent_seeds_diverge_immediately() {
        let first = |seed| Rng::new(seed).next_u64();
        assert_ne!(first(1), first(2));
        let a = first(1) ^ first(2);
        // At least a quarter of the bits differ; in practice it is about half.
        assert!(a.count_ones() > 16, "seeds 1 and 2 differ in only {} bits", a.count_ones());
    }

    #[test]
    fn a_shuffle_keeps_every_element() {
        let mut r = Rng::new(7);
        let mut v: Vec<u32> = (0..500).collect();
        r.shuffle(&mut v);
        v.sort();
        assert_eq!(v, (0..500).collect::<Vec<u32>>());
    }

    #[test]
    fn text_seeds_are_stable_and_numbers_are_themselves() {
        assert_eq!(parse_seed("12345"), 12345);
        assert_eq!(parse_seed("tuesday night"), parse_seed("tuesday night"));
        assert_ne!(parse_seed("tuesday night"), parse_seed("tuesday nigh"));
    }

    #[test]
    fn below_stays_in_range() {
        let mut r = Rng::new(3);
        for n in 1..40u64 {
            for _ in 0..50 {
                assert!(r.below(n) < n);
            }
        }
    }
}
