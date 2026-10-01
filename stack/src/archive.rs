//! Streaming `.tar.gz`, SHA-256 and CRC-32, for the whole-world backup.
//!
//! `stack` has no dependencies on purpose (see Cargo.toml), and a backup has
//! to be one file a player can keep, open with any archiver, and restore on a
//! machine that has nothing but this binary. So the three formats it needs
//! are written out here:
//!
//! - **gzip/deflate**: a compressor (LZ77 over a 32 KiB window, fixed Huffman
//!   codes, falling back to stored blocks where that is smaller -- already
//!   compressed sprites and music cost nothing extra), and a full inflater
//!   that also reads dynamic-Huffman streams, so an archive somebody repacked
//!   with `tar czf` still restores.
//! - **ustar**, with PAX records for long names and large sizes.
//! - **SHA-256**, for the manifest's per-file checksums and mod hashes.
//!
//! Everything streams: a mod with a gigabyte of maps is read and written in
//! pieces, never held in memory whole.

use std::io::{self, BufRead, Read, Write};

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

#[derive(Clone)]
pub struct Sha256 {
    state: [u32; 8],
    block: [u8; 64],
    filled: usize,
    length: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Sha256 {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            block: [0; 64],
            filled: 0,
            length: 0,
        }
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        while !data.is_empty() {
            let take = (64 - self.filled).min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
            if self.filled == 64 {
                let block = self.block;
                self.compress(&block);
                self.filled = 0;
            }
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (s, v) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }

    pub fn hex(mut self) -> String {
        let bits = self.length.wrapping_mul(8);
        self.update(&[0x80]);
        while self.filled != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        self.state.iter().map(|w| format!("{w:08x}")).collect()
    }
}

#[cfg(test)]
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    h.hex()
}

/// SHA-256 of everything read from `input`, and how many bytes that was.
pub fn sha256_reader(mut input: impl Read) -> io::Result<(String, u64)> {
    let mut h = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            return Ok((h.hex(), total));
        }
        total += n as u64;
        h.update(&buffer[..n]);
    }
}

// ---------------------------------------------------------------------------
// CRC-32 (gzip's)
// ---------------------------------------------------------------------------

fn crc_table() -> &'static [u32; 256] {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, slot) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    })
}

pub fn crc32_update(crc: u32, data: &[u8]) -> u32 {
    let t = crc_table();
    let mut c = !crc;
    for &b in data {
        c = t[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    !c
}

// ---------------------------------------------------------------------------
// Deflate: shared tables
// ---------------------------------------------------------------------------

const LEN_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LEN_EXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/// The last table index whose base is at most `value`.
fn code_for(bases: &[u16], value: u16) -> usize {
    bases.iter().rposition(|&b| b <= value).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Deflate: compressor
// ---------------------------------------------------------------------------

struct BitWriter<W: Write> {
    inner: W,
    bits: u64,
    count: u32,
    staged: Vec<u8>,
}

impl<W: Write> BitWriter<W> {
    fn put(&mut self, value: u32, n: u32) -> io::Result<()> {
        self.bits |= (value as u64) << self.count;
        self.count += n;
        while self.count >= 8 {
            self.staged.push(self.bits as u8);
            self.bits >>= 8;
            self.count -= 8;
        }
        if self.staged.len() >= 64 * 1024 {
            self.inner.write_all(&self.staged)?;
            self.staged.clear();
        }
        Ok(())
    }

    /// Pad to a byte boundary with zero bits.
    fn align(&mut self) -> io::Result<()> {
        if self.count > 0 {
            let n = 8 - self.count;
            self.put(0, n)?;
        }
        Ok(())
    }

    fn bytes(&mut self, data: &[u8]) -> io::Result<()> {
        debug_assert_eq!(self.count, 0);
        self.staged.extend_from_slice(data);
        if self.staged.len() >= 64 * 1024 {
            self.inner.write_all(&self.staged)?;
            self.staged.clear();
        }
        Ok(())
    }

    fn flush_staged(&mut self) -> io::Result<()> {
        self.inner.write_all(&self.staged)?;
        self.staged.clear();
        Ok(())
    }
}

fn reverse(code: u32, len: u32) -> u32 {
    code.reverse_bits() >> (32 - len)
}

/// The fixed literal/length code for `symbol`, already bit-reversed.
fn fixed_literal(symbol: u16) -> (u32, u32) {
    let s = symbol as u32;
    let (code, len) = match s {
        0..=143 => (0x30 + s, 8),
        144..=255 => (0x190 + s - 144, 9),
        256..=279 => (s - 256, 7),
        _ => (0xC0 + s - 280, 8),
    };
    (reverse(code, len), len)
}

const WSIZE: usize = 32 * 1024;
const WMASK: usize = WSIZE - 1;
const HBITS: u32 = 15;
const HSIZE: usize = 1 << HBITS;
const MAX_MATCH: usize = 258;
const MIN_MATCH: usize = 3;
const BLOCK: usize = 64 * 1024;
const MAX_CHAIN: usize = 48;

#[derive(Clone, Copy)]
enum Symbol {
    Literal(u8),
    Match { len: u16, dist: u16 },
}

/// A streaming raw-deflate encoder.
pub struct Deflater<W: Write> {
    out: BitWriter<W>,
    /// History (at most WSIZE bytes before `pos`) followed by pending input.
    buf: Vec<u8>,
    pos: usize,
    /// Positions + 1 into `buf`; 0 is "none".
    head: Vec<usize>,
    prev: Vec<usize>,
    /// Where hashing has reached; every position before it is in the chains.
    hashed: usize,
}

fn hash3(b: &[u8]) -> usize {
    (((b[0] as usize) << 10) ^ ((b[1] as usize) << 5) ^ (b[2] as usize)) & (HSIZE - 1)
}

impl<W: Write> Deflater<W> {
    pub fn new(inner: W) -> Self {
        Deflater {
            out: BitWriter { inner, bits: 0, count: 0, staged: Vec::with_capacity(70 * 1024) },
            buf: Vec::with_capacity(WSIZE + 2 * BLOCK),
            pos: 0,
            head: vec![0; HSIZE],
            prev: vec![0; WSIZE],
            hashed: 0,
        }
    }

    fn insert(&mut self, i: usize) {
        if i + MIN_MATCH <= self.buf.len() {
            let h = hash3(&self.buf[i..]);
            self.prev[i & WMASK] = self.head[h];
            self.head[h] = i + 1;
        }
    }

    fn longest(&self, i: usize) -> (usize, usize) {
        let avail = (self.buf.len() - i).min(MAX_MATCH);
        if avail < MIN_MATCH {
            return (0, 0);
        }
        let mut best = (0, 0);
        let mut cand = self.head[hash3(&self.buf[i..])];
        let mut chain = 0;
        while cand != 0 && chain < MAX_CHAIN {
            let c = cand - 1;
            if c >= i || i - c > WSIZE {
                break;
            }
            let a = &self.buf[c..c + avail];
            let b = &self.buf[i..i + avail];
            if a[best.0.min(avail - 1)] == b[best.0.min(avail - 1)] {
                let len = a.iter().zip(b).take_while(|(x, y)| x == y).count();
                if len > best.0 {
                    best = (len, i - c);
                    if len == avail {
                        break;
                    }
                }
            }
            let next = self.prev[c & WMASK];
            if next == 0 || next - 1 >= c {
                break;
            }
            cand = next;
            chain += 1;
        }
        if best.0 >= MIN_MATCH { best } else { (0, 0) }
    }

    /// Encode input from `pos` up to at least `limit` as one or more blocks.
    fn block(&mut self, limit: usize, last: bool) -> io::Result<()> {
        let start = self.pos;
        let mut symbols = Vec::with_capacity(limit - start);
        let mut i = start;
        while i < limit {
            while self.hashed < i {
                self.insert(self.hashed);
                self.hashed += 1;
            }
            let (len, dist) = self.longest(i);
            if len >= MIN_MATCH {
                symbols.push(Symbol::Match { len: len as u16, dist: dist as u16 });
                i += len;
            } else {
                symbols.push(Symbol::Literal(self.buf[i]));
                i += 1;
            }
        }
        let end = i;
        // Fixed-code cost against stored cost; the cheaper one wins.
        let mut fixed_bits: u64 = 3 + 7;
        for s in &symbols {
            fixed_bits += match *s {
                Symbol::Literal(b) => if b < 144 { 8 } else { 9 },
                Symbol::Match { len, dist } => {
                    let l = code_for(&LEN_BASE, len);
                    let d = code_for(&DIST_BASE, dist);
                    (if l + 257 < 280 { 7 } else { 8 }) + LEN_EXTRA[l] as u64 + 5 + DIST_EXTRA[d] as u64
                }
            };
        }
        let raw = end - start;
        let chunks = raw.div_ceil(65535).max(1) as u64;
        let stored_bits = raw as u64 * 8 + chunks * (3 + 7 + 32);
        if stored_bits < fixed_bits {
            let mut at = start;
            loop {
                let n = (end - at).min(65535);
                let final_chunk = at + n == end;
                self.out.put((last && final_chunk) as u32, 1)?;
                self.out.put(0, 2)?;
                self.out.align()?;
                self.out.put(n as u32, 16)?;
                self.out.put(!(n as u32) & 0xffff, 16)?;
                let data = self.buf[at..at + n].to_vec();
                self.out.bytes(&data)?;
                at += n;
                if final_chunk {
                    break;
                }
            }
        } else {
            self.out.put(last as u32, 1)?;
            self.out.put(1, 2)?;
            for s in symbols {
                match s {
                    Symbol::Literal(b) => {
                        let (c, n) = fixed_literal(b as u16);
                        self.out.put(c, n)?;
                    }
                    Symbol::Match { len, dist } => {
                        let l = code_for(&LEN_BASE, len);
                        let (c, n) = fixed_literal(257 + l as u16);
                        self.out.put(c, n)?;
                        self.out.put((len - LEN_BASE[l]) as u32, LEN_EXTRA[l] as u32)?;
                        let d = code_for(&DIST_BASE, dist);
                        self.out.put(reverse(d as u32, 5), 5)?;
                        self.out.put((dist - DIST_BASE[d]) as u32, DIST_EXTRA[d] as u32)?;
                    }
                }
            }
            let (c, n) = fixed_literal(256);
            self.out.put(c, n)?;
        }
        self.pos = end;
        self.slide();
        Ok(())
    }

    /// Drop history older than the window, renumbering the hash chains.
    fn slide(&mut self) {
        if self.pos < 2 * WSIZE {
            return;
        }
        let shift = self.pos - WSIZE;
        self.buf.drain(..shift);
        self.pos -= shift;
        self.hashed -= shift;
        let fix = |v: &mut usize| *v = if *v > shift { *v - shift } else { 0 };
        self.head.iter_mut().for_each(fix);
        // prev is indexed by position mod WSIZE, and shift is not necessarily
        // a multiple of it: rebuild the ring at its new offsets.
        let mut moved = vec![0; WSIZE];
        for p in self.pos.saturating_sub(WSIZE)..self.hashed {
            let old = p + shift;
            let mut v = self.prev[old & WMASK];
            fix(&mut v);
            moved[p & WMASK] = v;
        }
        self.prev = moved;
    }

    pub fn finish(mut self) -> io::Result<W> {
        let end = self.buf.len();
        if end == self.pos {
            // Nothing left: an empty final fixed block.
            self.out.put(1, 1)?;
            self.out.put(1, 2)?;
            let (c, n) = fixed_literal(256);
            self.out.put(c, n)?;
        } else {
            self.block(end, true)?;
        }
        self.out.align()?;
        self.out.flush_staged()?;
        Ok(self.out.inner)
    }
}

impl<W: Write> Write for Deflater<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        while self.buf.len() - self.pos >= BLOCK + MAX_MATCH {
            let limit = self.pos + BLOCK;
            self.block(limit, false)?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Inflate
// ---------------------------------------------------------------------------

fn corrupt(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("damaged archive: {what}"))
}

struct BitReader<R: BufRead> {
    inner: R,
    bits: u64,
    count: u32,
}

impl<R: BufRead> BitReader<R> {
    fn need(&mut self, n: u32) -> io::Result<()> {
        while self.count < n {
            let mut b = [0u8; 1];
            self.inner.read_exact(&mut b).map_err(|_| corrupt("the file ends early"))?;
            self.bits |= (b[0] as u64) << self.count;
            self.count += 8;
        }
        Ok(())
    }

    fn get(&mut self, n: u32) -> io::Result<u32> {
        if n == 0 {
            return Ok(0);
        }
        self.need(n)?;
        let v = (self.bits & ((1u64 << n) - 1)) as u32;
        self.bits >>= n;
        self.count -= n;
        Ok(v)
    }

    /// Drop the rest of the current byte. Bits are only ever fetched one byte
    /// at a time, so whatever is buffered belongs to that byte.
    fn align(&mut self) {
        self.bits = 0;
        self.count = 0;
    }
}

/// A canonical Huffman decoding table, decoded a bit at a time (as in zlib's
/// `puff`): small, obviously correct, and fast enough for a restore.
struct Huffman {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

impl Huffman {
    fn new(lengths: &[u8]) -> io::Result<Huffman> {
        let mut counts = [0u16; 16];
        for &l in lengths {
            counts[l as usize] += 1;
        }
        counts[0] = 0;
        let mut left: i32 = 1;
        for &c in counts.iter().skip(1) {
            left = left * 2 - c as i32;
            if left < 0 {
                return Err(corrupt("an over-subscribed code"));
            }
        }
        let mut offs = [0u16; 16];
        for len in 1..15 {
            offs[len + 1] = offs[len] + counts[len];
        }
        let mut symbols = vec![0u16; lengths.len()];
        for (sym, &l) in lengths.iter().enumerate() {
            if l != 0 {
                symbols[offs[l as usize] as usize] = sym as u16;
                offs[l as usize] += 1;
            }
        }
        Ok(Huffman { counts, symbols })
    }

    fn decode<R: BufRead>(&self, input: &mut BitReader<R>) -> io::Result<u16> {
        let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
        for len in 1..16 {
            code |= input.get(1)? as i32;
            let count = self.counts[len] as i32;
            if code - count < first {
                return Ok(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        Err(corrupt("an invalid code"))
    }
}

enum Block {
    Header,
    Stored(usize),
    Coded(Huffman, Huffman),
    Done,
}

/// A streaming raw-deflate decoder.
pub struct Inflater<R: BufRead> {
    input: BitReader<R>,
    /// Output, of which `out[..read]` has been returned; at least the last
    /// WSIZE bytes are kept as history for back-references.
    out: Vec<u8>,
    read: usize,
    block: Block,
    last: bool,
}

impl<R: BufRead> Inflater<R> {
    pub fn new(inner: R) -> Self {
        Inflater { input: BitReader { inner, bits: 0, count: 0 }, out: Vec::new(), read: 0, block: Block::Header, last: false }
    }

    fn fixed() -> io::Result<(Huffman, Huffman)> {
        let mut l = [0u8; 288];
        l[..144].fill(8);
        l[144..256].fill(9);
        l[256..280].fill(7);
        l[280..].fill(8);
        Ok((Huffman::new(&l)?, Huffman::new(&[5u8; 30])?))
    }

    fn dynamic(&mut self) -> io::Result<(Huffman, Huffman)> {
        const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        let nlen = self.input.get(5)? as usize + 257;
        let ndist = self.input.get(5)? as usize + 1;
        let ncode = self.input.get(4)? as usize + 4;
        if nlen > 286 || ndist > 30 {
            return Err(corrupt("bad code counts"));
        }
        let mut lengths = [0u8; 19];
        for &o in ORDER.iter().take(ncode) {
            lengths[o] = self.input.get(3)? as u8;
        }
        let lencode = Huffman::new(&lengths)?;
        let mut all = vec![0u8; nlen + ndist];
        let mut i = 0;
        while i < nlen + ndist {
            let sym = lencode.decode(&mut self.input)?;
            if sym < 16 {
                all[i] = sym as u8;
                i += 1;
                continue;
            }
            let (value, repeat) = match sym {
                16 => {
                    if i == 0 {
                        return Err(corrupt("a repeat with nothing before it"));
                    }
                    (all[i - 1], 3 + self.input.get(2)? as usize)
                }
                17 => (0, 3 + self.input.get(3)? as usize),
                _ => (0, 11 + self.input.get(7)? as usize),
            };
            if i + repeat > nlen + ndist {
                return Err(corrupt("too many code lengths"));
            }
            all[i..i + repeat].fill(value);
            i += repeat;
        }
        if all[256] == 0 {
            return Err(corrupt("no end-of-block code"));
        }
        Ok((Huffman::new(&all[..nlen])?, Huffman::new(&all[nlen..])?))
    }

    /// Decode until at least `want` unread bytes are buffered or the stream ends.
    fn fill(&mut self, want: usize) -> io::Result<()> {
        while self.out.len() - self.read < want {
            match &mut self.block {
                Block::Done => return Ok(()),
                Block::Header => {
                    if self.last {
                        self.block = Block::Done;
                        continue;
                    }
                    self.last = self.input.get(1)? == 1;
                    self.block = match self.input.get(2)? {
                        0 => {
                            self.input.align();
                            let len = self.input.get(16)?;
                            let nlen = self.input.get(16)?;
                            if len != !nlen & 0xffff {
                                return Err(corrupt("a stored block's length"));
                            }
                            Block::Stored(len as usize)
                        }
                        1 => {
                            let (l, d) = Self::fixed()?;
                            Block::Coded(l, d)
                        }
                        2 => {
                            let (l, d) = self.dynamic()?;
                            Block::Coded(l, d)
                        }
                        _ => return Err(corrupt("an unknown block type")),
                    };
                }
                Block::Stored(remaining) => {
                    if *remaining == 0 {
                        self.block = Block::Header;
                        continue;
                    }
                    let n = (*remaining).min(32 * 1024);
                    let at = self.out.len();
                    self.out.resize(at + n, 0);
                    self.input.inner.read_exact(&mut self.out[at..]).map_err(|_| corrupt("the file ends early"))?;
                    *remaining -= n;
                }
                Block::Coded(lit, dist) => {
                    let sym = lit.decode(&mut self.input)?;
                    if sym < 256 {
                        self.out.push(sym as u8);
                    } else if sym == 256 {
                        self.block = Block::Header;
                    } else {
                        let l = (sym - 257) as usize;
                        if l >= 29 {
                            return Err(corrupt("a bad length code"));
                        }
                        let len = LEN_BASE[l] as usize + self.input.get(LEN_EXTRA[l] as u32)? as usize;
                        let d = dist.decode(&mut self.input)? as usize;
                        if d >= 30 {
                            return Err(corrupt("a bad distance code"));
                        }
                        let distance = DIST_BASE[d] as usize + self.input.get(DIST_EXTRA[d] as u32)? as usize;
                        if distance > self.out.len() {
                            return Err(corrupt("a distance too far back"));
                        }
                        let from = self.out.len() - distance;
                        for k in 0..len {
                            let b = self.out[from + k];
                            self.out.push(b);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

impl<R: BufRead> Read for Inflater<R> {
    fn read(&mut self, dest: &mut [u8]) -> io::Result<usize> {
        if dest.is_empty() {
            return Ok(0);
        }
        if self.read == self.out.len() {
            if self.read > 2 * WSIZE {
                let drop = self.read - WSIZE;
                self.out.drain(..drop);
                self.read -= drop;
            }
            self.fill(64 * 1024)?;
        }
        let n = (self.out.len() - self.read).min(dest.len());
        dest[..n].copy_from_slice(&self.out[self.read..self.read + n]);
        self.read += n;
        Ok(n)
    }
}

// ---------------------------------------------------------------------------
// gzip
// ---------------------------------------------------------------------------

pub struct GzipWriter<W: Write> {
    deflate: Deflater<W>,
    crc: u32,
    size: u64,
}

impl<W: Write> GzipWriter<W> {
    pub fn new(mut inner: W) -> io::Result<Self> {
        // No name, no timestamp: the manifest carries the date.
        inner.write_all(&[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255])?;
        Ok(GzipWriter { deflate: Deflater::new(inner), crc: 0, size: 0 })
    }

    pub fn finish(self) -> io::Result<W> {
        let mut inner = self.deflate.finish()?;
        inner.write_all(&self.crc.to_le_bytes())?;
        inner.write_all(&(self.size as u32).to_le_bytes())?;
        inner.flush()?;
        Ok(inner)
    }
}

impl<W: Write> Write for GzipWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.crc = crc32_update(self.crc, data);
        self.size += data.len() as u64;
        self.deflate.write_all(data)?;
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub struct GzipReader<R: BufRead> {
    inflate: Inflater<R>,
    crc: u32,
    size: u64,
    checked: bool,
}

impl<R: BufRead> GzipReader<R> {
    pub fn new(mut inner: R) -> io::Result<Self> {
        let mut h = [0u8; 10];
        inner.read_exact(&mut h).map_err(|_| corrupt("not a gzip file"))?;
        if h[0] != 0x1f || h[1] != 0x8b || h[2] != 8 {
            return Err(corrupt("not a gzip file"));
        }
        let flags = h[3];
        if flags & 4 != 0 {
            let mut x = [0u8; 2];
            inner.read_exact(&mut x)?;
            io::copy(&mut (&mut inner).take(u16::from_le_bytes(x) as u64), &mut io::sink())?;
        }
        for bit in [8u8, 16] {
            if flags & bit != 0 {
                let mut skipped = Vec::new();
                inner.read_until(0, &mut skipped)?;
            }
        }
        if flags & 2 != 0 {
            inner.read_exact(&mut [0u8; 2])?;
        }
        Ok(GzipReader { inflate: Inflater::new(inner), crc: 0, size: 0, checked: false })
    }
}

impl<R: BufRead> Read for GzipReader<R> {
    fn read(&mut self, dest: &mut [u8]) -> io::Result<usize> {
        let n = self.inflate.read(dest)?;
        if n == 0 && !dest.is_empty() && !self.checked {
            self.inflate.input.align();
            let mut t = [0u8; 8];
            self.inflate.input.inner.read_exact(&mut t).map_err(|_| corrupt("the file ends early"))?;
            if u32::from_le_bytes([t[0], t[1], t[2], t[3]]) != self.crc
                || u32::from_le_bytes([t[4], t[5], t[6], t[7]]) != self.size as u32
            {
                return Err(corrupt("its gzip checksum does not match"));
            }
            self.checked = true;
        }
        self.crc = crc32_update(self.crc, &dest[..n]);
        self.size += n as u64;
        Ok(n)
    }
}

// ---------------------------------------------------------------------------
// tar (ustar + PAX)
// ---------------------------------------------------------------------------

fn octal(field: &mut [u8], value: u64) {
    let digits = field.len() - 1;
    let s = format!("{value:0digits$o}");
    field[..digits].copy_from_slice(&s.as_bytes()[s.len() - digits..]);
    field[digits] = 0;
}

fn header(name: &str, size: u64, mtime: u64, kind: u8) -> [u8; 512] {
    let mut h = [0u8; 512];
    let n = name.as_bytes();
    let take = n.len().min(100);
    h[..take].copy_from_slice(&n[..take]);
    octal(&mut h[100..108], 0o644);
    octal(&mut h[108..116], 0);
    octal(&mut h[116..124], 0);
    octal(&mut h[124..136], size.min(0o77777777777));
    octal(&mut h[136..148], mtime.min(0o77777777777));
    h[156] = kind;
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    h[148..156].fill(b' ');
    let sum: u32 = h.iter().map(|&b| b as u32).sum();
    let s = format!("{sum:06o}\0 ");
    h[148..156].copy_from_slice(s.as_bytes());
    h
}

fn pax_record(key: &str, value: &str) -> String {
    // The length counts itself, so settle it by iteration.
    let body = format!(" {key}={value}\n");
    let mut len = body.len() + 1;
    while format!("{len}{body}").len() != len {
        len = format!("{len}{body}").len();
    }
    format!("{len}{body}")
}

pub struct TarWriter<W: Write> {
    inner: W,
}

impl<W: Write> TarWriter<W> {
    pub fn new(inner: W) -> Self {
        TarWriter { inner }
    }

    fn pad(&mut self, size: u64) -> io::Result<()> {
        let rem = (size % 512) as usize;
        if rem != 0 {
            self.inner.write_all(&vec![0u8; 512 - rem])?;
        }
        Ok(())
    }

    /// Append a regular file, copying exactly `size` bytes from `data`.
    pub fn file(&mut self, name: &str, size: u64, mtime: u64, data: impl Read) -> io::Result<()> {
        let mut pax = String::new();
        if name.len() > 100 || !name.is_ascii() {
            pax.push_str(&pax_record("path", name));
        }
        if size > 0o77777777777 {
            pax.push_str(&pax_record("size", &size.to_string()));
        }
        if !pax.is_empty() {
            self.inner.write_all(&header("././@PaxHeader", pax.len() as u64, mtime, b'x'))?;
            self.inner.write_all(pax.as_bytes())?;
            self.pad(pax.len() as u64)?;
        }
        let short: String = if name.is_ascii() { name.chars().take(100).collect() } else { "file".into() };
        self.inner.write_all(&header(&short, size, mtime, b'0'))?;
        let copied = io::copy(&mut data.take(size), &mut self.inner)?;
        if copied != size {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, format!("{name} changed size while it was being archived")));
        }
        self.pad(size)
    }

    pub fn finish(mut self) -> io::Result<W> {
        self.inner.write_all(&[0u8; 1024])?;
        Ok(self.inner)
    }
}

pub struct Entry {
    pub path: String,
    pub size: u64,
}

pub struct TarReader<R: Read> {
    inner: R,
    remaining: u64,
    padding: u64,
}

fn parse_number(field: &[u8]) -> io::Result<u64> {
    if field.first().map(|b| b & 0x80 != 0).unwrap_or(false) {
        // GNU base-256.
        let mut v: u64 = (field[0] & 0x7f) as u64;
        for &b in &field[1..] {
            v = v.checked_mul(256).ok_or_else(|| corrupt("a size too large"))? | b as u64;
        }
        return Ok(v);
    }
    let text: String = field.iter().take_while(|&&b| b != 0).map(|&b| b as char).collect();
    let text = text.trim();
    if text.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(text, 8).map_err(|_| corrupt("a bad number in a header"))
}

fn text(field: &[u8]) -> String {
    String::from_utf8_lossy(&field[..field.iter().position(|&b| b == 0).unwrap_or(field.len())]).into_owned()
}

impl<R: Read> TarReader<R> {
    pub fn new(inner: R) -> Self {
        TarReader { inner, remaining: 0, padding: 0 }
    }

    fn skip_rest(&mut self) -> io::Result<()> {
        let n = self.remaining + self.padding;
        if n > 0 {
            let copied = io::copy(&mut (&mut self.inner).take(n), &mut io::sink())?;
            if copied != n {
                return Err(corrupt("the file ends early"));
            }
        }
        self.remaining = 0;
        self.padding = 0;
        Ok(())
    }

    fn body(&mut self, size: u64) -> io::Result<Vec<u8>> {
        if size > 1024 * 1024 {
            return Err(corrupt("an oversized extended header"));
        }
        let mut v = vec![0u8; size as usize];
        self.inner.read_exact(&mut v).map_err(|_| corrupt("the file ends early"))?;
        let rem = size % 512;
        if rem != 0 {
            io::copy(&mut (&mut self.inner).take(512 - rem), &mut io::sink())?;
        }
        Ok(v)
    }

    /// The next regular file, skipping directories. Links and devices are
    /// refused: nothing this app writes contains one, and following one on
    /// restore is how an archive writes outside its folder.
    pub fn next_entry(&mut self) -> io::Result<Option<Entry>> {
        self.skip_rest()?;
        let mut long_name: Option<String> = None;
        let mut long_size: Option<u64> = None;
        loop {
            let mut h = [0u8; 512];
            if let Err(e) = self.inner.read_exact(&mut h) {
                return if e.kind() == io::ErrorKind::UnexpectedEof { Err(corrupt("the file ends early")) } else { Err(e) };
            }
            if h.iter().all(|&b| b == 0) {
                return Ok(None);
            }
            let recorded = parse_number(&h[148..156])?;
            let mut check = h;
            check[148..156].fill(b' ');
            if check.iter().map(|&b| b as u64).sum::<u64>() != recorded {
                return Err(corrupt("a header checksum"));
            }
            let size = parse_number(&h[124..136])?;
            let kind = h[156];
            match kind {
                b'x' => {
                    let body = self.body(size)?;
                    let body = String::from_utf8_lossy(&body).into_owned();
                    for record in body.split('\n') {
                        if let Some((_, kv)) = record.split_once(' ') {
                            if let Some(v) = kv.strip_prefix("path=") {
                                long_name = Some(v.to_string());
                            } else if let Some(v) = kv.strip_prefix("size=") {
                                long_size = Some(v.parse().map_err(|_| corrupt("a bad size"))?);
                            }
                        }
                    }
                }
                b'g' => {
                    self.body(size)?;
                }
                b'L' => {
                    let body = self.body(size)?;
                    long_name = Some(text(&body));
                }
                b'0' | 0 | b'7' | b'5' => {
                    let size = long_size.take().unwrap_or(size);
                    let path = long_name.take().unwrap_or_else(|| {
                        let name = text(&h[0..100]);
                        let prefix = if &h[257..262] == b"ustar" { text(&h[345..500]) } else { String::new() };
                        if prefix.is_empty() { name } else { format!("{prefix}/{name}") }
                    });
                    if kind == b'5' {
                        self.remaining = size;
                        self.padding = (512 - size % 512) % 512;
                        self.skip_rest()?;
                        continue;
                    }
                    self.remaining = size;
                    self.padding = (512 - size % 512) % 512;
                    return Ok(Some(Entry { path, size }));
                }
                _ => return Err(corrupt("a link or special file, which a backup never contains")),
            }
        }
    }

    pub fn into_inner(self) -> R {
        self.inner
    }
}

impl<R: Read> Read for TarReader<R> {
    fn read(&mut self, dest: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let want = (dest.len() as u64).min(self.remaining) as usize;
        let n = self.inner.read(&mut dest[..want])?;
        if n == 0 {
            return Err(corrupt("the file ends early"));
        }
        self.remaining -= n as u64;
        Ok(n)
    }
}

/// An archive member name that is safe to join under a directory: relative,
/// `/`-separated, and with no component that could climb out or mean
/// something special on Windows.
pub fn safe_path(path: &str) -> Option<Vec<&str>> {
    let path = path.strip_prefix("./").unwrap_or(path);
    if path.is_empty() || path.starts_with('/') {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    for p in &parts {
        if p.is_empty()
            || *p == "."
            || *p == ".."
            || p.contains(['\\', ':', '\0'])
            || p.ends_with(' ')
            || p.ends_with('.')
        {
            return None;
        }
    }
    Some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_answers() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // Split updates agree with one update.
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7) as u8).collect();
        let mut h = Sha256::new();
        for chunk in data.chunks(13) {
            h.update(chunk);
        }
        assert_eq!(h.hex(), sha256_hex(&data));
    }

    #[test]
    fn crc32_known_answer() {
        assert_eq!(crc32_update(0, b"123456789"), 0xCBF43926);
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut w = GzipWriter::new(Vec::new()).unwrap();
        for chunk in data.chunks(7919) {
            w.write_all(chunk).unwrap();
        }
        w.finish().unwrap()
    }

    fn gunzip(data: &[u8]) -> io::Result<Vec<u8>> {
        let mut r = GzipReader::new(io::BufReader::new(data))?;
        let mut out = Vec::new();
        r.read_to_end(&mut out)?;
        Ok(out)
    }

    fn sample(n: usize, seed: u32) -> Vec<u8> {
        // Text-like, with long repeats and some noise, like a SQL dump.
        let mut x = seed;
        let words = [b"INSERT INTO `char` VALUES ".as_slice(), b"(150000,'Agent',4252,99,0)", b",", b"\n", b"NULL", b"prontera"];
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            if x >> 28 == 0 {
                out.push((x >> 16) as u8);
            } else {
                out.extend_from_slice(words[(x >> 16) as usize % words.len()]);
            }
        }
        out.truncate(n);
        out
    }

    #[test]
    fn deflate_round_trips_every_shape() {
        let noise: Vec<u8> = {
            let mut x = 1u32;
            (0..300_000).map(|_| { x ^= x << 13; x ^= x >> 17; x ^= x << 5; x as u8 }).collect()
        };
        for data in [
            Vec::new(),
            b"a".to_vec(),
            b"abcabcabcabcabcabc".to_vec(),
            vec![0u8; 1_000_000],
            sample(400_000, 7),
            noise.clone(),
            [sample(100_000, 3), noise[..100_000].to_vec(), sample(200_000, 9)].concat(),
        ] {
            let z = gzip(&data);
            assert_eq!(gunzip(&z).unwrap(), data, "length {}", data.len());
        }
        // Text compresses; noise does not grow by more than the stored overhead.
        assert!(gzip(&sample(400_000, 7)).len() < 400_000 / 3);
        assert!(gzip(&noise).len() < noise.len() + noise.len() / 1000 + 64);
    }

    /// A stream from real zlib (Python's `gzip.compress`, level 9) that uses a
    /// dynamic Huffman block -- the kind an archive repacked by `tar czf`
    /// contains, and the kind this module never writes itself. The input was
    /// 400 random picks from "aaaaaaaabbbbccd" (Python's random.seed(5)).
    #[test]
    fn inflates_dynamic_huffman_from_zlib() {
        let z: &[u8] = &[
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x13, 0x5d, 0x50, 0x09, 0x12, 0xc4, 0x30,
            0x08, 0x7a, 0xab, 0xe0, 0xff, 0xdf, 0x50, 0x0e, 0xdb, 0x9d, 0xd9, 0xb4, 0x35, 0x8d, 0x0a, 0x42,
            0x30, 0x18, 0x82, 0xc0, 0x6a, 0xd7, 0x83, 0xd9, 0xd1, 0xe2, 0xe8, 0x0f, 0x0e, 0x5a, 0x4b, 0x1d,
            0xfd, 0x01, 0x57, 0xeb, 0xab, 0xc4, 0x22, 0x4d, 0xc1, 0xcc, 0x6d, 0x22, 0x53, 0x27, 0x3e, 0x9a,
            0xf9, 0x82, 0x8f, 0xc6, 0x35, 0x38, 0x4b, 0x91, 0x87, 0xa0, 0x45, 0x90, 0x25, 0xce, 0x2c, 0xd3,
            0xdd, 0x80, 0x89, 0xb4, 0x90, 0xfa, 0x8c, 0x6d, 0xc7, 0xf1, 0x17, 0x5d, 0x81, 0xd8, 0x23, 0x28,
            0xd1, 0x82, 0x45, 0xfc, 0x14, 0xd2, 0x4d, 0x37, 0x06, 0xf6, 0x6e, 0x73, 0x8c, 0xe4, 0x50, 0x94,
            0xac, 0x73, 0x71, 0x92, 0x51, 0x5f, 0xaf, 0x70, 0xfa, 0x52, 0x84, 0xc2, 0xbf, 0x8f, 0xf8, 0x06,
            0xa5, 0xda, 0x12, 0xed, 0x27, 0xe5, 0xd3, 0x4e, 0xbc, 0x42, 0xee, 0xc2, 0xf0, 0x5a, 0x35, 0x2a,
            0xb9, 0x07, 0x05, 0x44, 0xa8, 0x83, 0x90, 0x01, 0x00, 0x00,
        ];
        assert_eq!((z[10] >> 1) & 3, 2, "the fixture must be a dynamic block");
        let out = gunzip(z).unwrap();
        assert_eq!(out.len(), 400);
        assert_eq!(sha256_hex(&out), "252d3bb44eb28cd2f1834514f32998256929b72d80691c0a47f0e87932de6764");
    }

    #[test]
    fn a_damaged_stream_is_refused() {
        let mut z = gzip(&sample(50_000, 1));
        let n = z.len();
        z[n - 6] ^= 1; // CRC
        assert!(gunzip(&z).is_err());
        let z = gzip(&sample(50_000, 1));
        assert!(gunzip(&z[..z.len() / 2]).is_err());
    }

    #[test]
    fn tar_round_trips_long_names_and_empty_files() {
        let long = format!("mods/{}/data/sprite/{}.spr", "x".repeat(80), "한글".repeat(10));
        let files: Vec<(String, Vec<u8>)> = vec![
            ("manifest.json".into(), b"{}".to_vec()),
            ("empty".into(), Vec::new()),
            (long.clone(), sample(5000, 2)),
            ("exactly512".into(), vec![1u8; 512]),
        ];
        let mut t = TarWriter::new(Vec::new());
        for (name, data) in &files {
            t.file(name, data.len() as u64, 0, &data[..]).unwrap();
        }
        let bytes = t.finish().unwrap();
        let mut r = TarReader::new(&bytes[..]);
        for (name, data) in &files {
            let e = r.next_entry().unwrap().unwrap();
            assert_eq!(&e.path, name);
            let mut got = Vec::new();
            (&mut r).read_to_end(&mut got).unwrap();
            assert_eq!(&got, data);
        }
        assert!(r.next_entry().unwrap().is_none());
    }

    #[test]
    fn unsafe_member_names_are_refused() {
        for bad in ["/etc/passwd", "../x", "mods/../../x", "a//b", "C:/x", "a\\b", "mods/x.", ""] {
            assert!(safe_path(bad).is_none(), "{bad}");
        }
        assert_eq!(safe_path("./mods/a/b.txt").unwrap(), vec!["mods", "a", "b.txt"]);
    }
}
