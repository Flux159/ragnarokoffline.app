//! A small JSON reader.
//!
//! `stack` has no dependencies on purpose, and the one thing here that needs
//! to read JSON is `mod.json` -- a manifest a stranger wrote and handed to a
//! player. That is exactly the file a quote-hunting `split("\"description\"")`
//! gets wrong: a description containing an escaped quote, a `requires` block
//! nested one level down, a trailing comma somebody's editor left behind.
//!
//! So: a real parser, small enough to read in one sitting, strict enough to
//! say *no* with a reason rather than half-understand a file. It is the only
//! JSON parser in the tree; nothing else should grow a second one.

use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

impl Value {
    /// The string at `key`, if this is an object and the value is a string.
    ///
    /// Deliberately not "the value at `key`, stringified": a manifest that
    /// says `"version": 1.2` means something different from `"1.2.0"`, and
    /// silently coercing it would hide the mistake rather than report it.
    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(m) => m.get(key),
            _ => None,
        }
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Value::Object(_))
    }
}

impl fmt::Display for Value {
    /// Only what an error message needs: the type, not the contents.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Value::Null => "null",
            Value::Bool(_) => "a true/false value",
            Value::Number(_) => "a number",
            Value::String(_) => "a string",
            Value::Array(_) => "a list",
            Value::Object(_) => "an object",
        };
        f.write_str(name)
    }
}

/// Parse a complete JSON document. Trailing content is an error, because a
/// second object after the first is a file somebody meant to edit and did not.
pub fn parse(src: &str) -> Result<Value, String> {
    let b: Vec<char> = src.chars().collect();
    let mut p = Parser { b: &b, i: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i < p.b.len() {
        return Err(p.err("unexpected text after the end of the document"));
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [char],
    i: usize,
}

impl<'a> Parser<'a> {
    /// Errors carry a line and column, because "invalid JSON" on a file
    /// somebody is about to hand to a stranger is not a usable complaint.
    fn err(&self, what: &str) -> String {
        let (mut line, mut col) = (1usize, 1usize);
        for c in &self.b[..self.i.min(self.b.len())] {
            if *c == '\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
        }
        format!("line {line}, column {col}: {what}")
    }

    fn peek(&self) -> Option<char> {
        self.b.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t' | '\n' | '\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: char) -> Result<(), String> {
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(self.err(&format!("expected '{c}'")))
        }
    }

    fn lit(&mut self, word: &str, v: Value) -> Result<Value, String> {
        if self.b[self.i..].starts_with(&word.chars().collect::<Vec<_>>()[..]) {
            self.i += word.chars().count();
            Ok(v)
        } else {
            Err(self.err("unrecognised value"))
        }
    }

    fn value(&mut self) -> Result<Value, String> {
        match self.peek() {
            None => Err(self.err("the file ended where a value was expected")),
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('"') => self.string().map(Value::String),
            Some('t') => self.lit("true", Value::Bool(true)),
            Some('f') => self.lit("false", Value::Bool(false)),
            Some('n') => self.lit("null", Value::Null),
            Some(c) if c == '-' || c.is_ascii_digit() => self.number(),
            Some(_) => Err(self.err("unrecognised value")),
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        self.eat('{')?;
        let mut map = BTreeMap::new();
        self.ws();
        if self.peek() == Some('}') {
            self.i += 1;
            return Ok(Value::Object(map));
        }
        loop {
            self.ws();
            // Named rather than "expected '\"'": an unquoted key is the single
            // most common way a hand-written manifest is wrong.
            if self.peek() != Some('"') {
                return Err(self.err("a name in quotes was expected here"));
            }
            let k = self.string()?;
            self.ws();
            self.eat(':')?;
            self.ws();
            let v = self.value()?;
            map.insert(k, v);
            self.ws();
            match self.peek() {
                Some(',') => {
                    self.i += 1;
                    self.ws();
                    // A trailing comma before '}' is legal in JavaScript and
                    // not in JSON, and is worth naming as itself.
                    if self.peek() == Some('}') {
                        return Err(self.err("a comma with nothing after it"));
                    }
                }
                Some('}') => {
                    self.i += 1;
                    return Ok(Value::Object(map));
                }
                _ => return Err(self.err("expected ',' or '}'")),
            }
        }
    }

    fn array(&mut self) -> Result<Value, String> {
        self.eat('[')?;
        let mut out = Vec::new();
        self.ws();
        if self.peek() == Some(']') {
            self.i += 1;
            return Ok(Value::Array(out));
        }
        loop {
            self.ws();
            out.push(self.value()?);
            self.ws();
            match self.peek() {
                Some(',') => {
                    self.i += 1;
                    self.ws();
                    if self.peek() == Some(']') {
                        return Err(self.err("a comma with nothing after it"));
                    }
                }
                Some(']') => {
                    self.i += 1;
                    return Ok(Value::Array(out));
                }
                _ => return Err(self.err("expected ',' or ']'")),
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.eat('"')?;
        let mut s = String::new();
        loop {
            let c = self.peek().ok_or_else(|| self.err("unterminated string"))?;
            self.i += 1;
            match c {
                '"' => return Ok(s),
                '\\' => {
                    let e = self.peek().ok_or_else(|| self.err("unterminated escape"))?;
                    self.i += 1;
                    match e {
                        '"' => s.push('"'),
                        '\\' => s.push('\\'),
                        '/' => s.push('/'),
                        'b' => s.push('\u{8}'),
                        'f' => s.push('\u{c}'),
                        'n' => s.push('\n'),
                        'r' => s.push('\r'),
                        't' => s.push('\t'),
                        'u' => {
                            let hi = self.hex4()?;
                            // A surrogate pair is two escapes, and a lone high
                            // surrogate is not a character: emit the
                            // replacement rather than refuse the file over a
                            // decorative emoji in a description.
                            let ch = if (0xD800..0xDC00).contains(&hi) {
                                let save = self.i;
                                if self.peek() == Some('\\') {
                                    self.i += 1;
                                    if self.peek() == Some('u') {
                                        self.i += 1;
                                        let lo = self.hex4()?;
                                        if (0xDC00..0xE000).contains(&lo) {
                                            let c = 0x10000
                                                + ((hi - 0xD800) << 10)
                                                + (lo - 0xDC00);
                                            char::from_u32(c).unwrap_or('\u{fffd}')
                                        } else {
                                            self.i = save;
                                            '\u{fffd}'
                                        }
                                    } else {
                                        self.i = save;
                                        '\u{fffd}'
                                    }
                                } else {
                                    '\u{fffd}'
                                }
                            } else {
                                char::from_u32(hi).unwrap_or('\u{fffd}')
                            };
                            s.push(ch);
                        }
                        _ => return Err(self.err("unrecognised escape")),
                    }
                }
                c if (c as u32) < 0x20 => {
                    return Err(self.err("a raw control character inside a string"))
                }
                c => s.push(c),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut v = 0u32;
        for _ in 0..4 {
            let c = self.peek().ok_or_else(|| self.err("truncated \\u escape"))?;
            let d = c.to_digit(16).ok_or_else(|| self.err("bad \\u escape"))?;
            v = v * 16 + d;
            self.i += 1;
        }
        Ok(v)
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.i;
        if self.peek() == Some('-') {
            self.i += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.i += 1;
        }
        if self.peek() == Some('.') {
            self.i += 1;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.i += 1;
            }
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.i += 1;
            if matches!(self.peek(), Some('+' | '-')) {
                self.i += 1;
            }
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.i += 1;
            }
        }
        let text: String = self.b[start..self.i].iter().collect();
        text.parse::<f64>().map(Value::Number).map_err(|_| {
            self.i = start;
            self.err("not a number")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(src: &str) -> Value {
        parse(src).unwrap()
    }

    /// The thing the old quote-hunting reader got wrong, and the reason this
    /// module exists: a description is prose, and prose contains quotes.
    #[test]
    fn a_description_may_contain_an_escaped_quote() {
        let v = obj(r#"{"description": "the \"best\" mod"}"#);
        assert_eq!(v.str("description"), Some(r#"the "best" mod"#));
    }

    #[test]
    fn a_key_named_description_inside_another_string_is_not_the_description() {
        let v = obj(r#"{"name": "\"description\": not this one", "description": "this one"}"#);
        assert_eq!(v.str("description"), Some("this one"));
    }

    #[test]
    fn nested_objects_read_back() {
        let v = obj(r#"{"requires": {"app": ">=1.0.6", "era": "renewal"}}"#);
        let r = v.get("requires").unwrap();
        assert_eq!(r.str("app"), Some(">=1.0.6"));
        assert_eq!(r.str("era"), Some("renewal"));
    }

    #[test]
    fn escapes_and_unicode() {
        let v = obj(r#"{"s": "a\tb\ncé😀"}"#);
        assert_eq!(v.str("s"), Some("a\tb\nc\u{e9}\u{1f600}"));
    }

    #[test]
    fn numbers_bools_null_and_arrays() {
        let v = obj(r#"{"a": [1, -2.5, 1e3, true, false, null]}"#);
        match v.get("a").unwrap() {
            Value::Array(a) => {
                assert_eq!(a.len(), 6);
                assert_eq!(a[2], Value::Number(1000.0));
            }
            other => panic!("expected a list, got {other}"),
        }
    }

    /// Refusing is the point: a mod whose manifest cannot be read must be
    /// reported, not guessed at.
    #[test]
    fn malformed_documents_are_refused_with_a_position() {
        for bad in [
            r#"{name: "x"}"#,
            r#"{"a": 1,}"#,
            r#"{"a": 1"#,
            r#"{"a": "unterminated}"#,
            r#"{} {}"#,
            r#""#,
        ] {
            let e = parse(bad).unwrap_err();
            assert!(e.starts_with("line "), "{bad:?} gave {e:?}");
        }
    }

    #[test]
    fn whitespace_and_empty_containers() {
        assert!(obj("  {\n\t\"a\": {},\r\n\"b\": []\n}  ").is_object());
    }
}
