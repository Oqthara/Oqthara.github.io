# Oqthara language reference

This file is not the documentation. It exists so the site's Firebase emulator
seed has something to load and so `scripts/audit-code-blocks.mjs` keeps a page
of its own to audit; readers never see it.

The guide they do see is published from the language repository:

- [Language guide](https://github.com/Oqthara/oqthara/blob/main/docs/reference/language-guide.md)
  — the reader's introduction, served under **Reference**.
- [Language specification](https://github.com/Oqthara/oqthara/blob/main/docs/spec/language.md)
  — the normative rules.

Keep exactly one copy of the guide. It lives in the language repository, which
the site publishes; a copy here would drift.

## Example

```
name = "World"
print "Hello, {name}!"

for n in 1 to 3
  print n
end
```
