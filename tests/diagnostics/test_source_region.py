"""Contract checks for the explicitly marked C++ diagnostic regions."""
import unittest

from source_region import source_region


class SourceRegionTests(unittest.TestCase):
    def test_preserves_nested_blocks_comments_and_literals(self):
        body = '''void example()
{
if (true) {
    const char *text = "} // DIAGNOSTIC-END: example";
    // A closing brace in a comment: }
}
}
'''
        source = '// DIAGNOSTIC-BEGIN: example\n' + body + '// DIAGNOSTIC-END: example\n'
        self.assertEqual(source_region(source, 'example', 'example.cpp'), body)

    def test_accepts_indented_markers_crlf_and_no_final_newline(self):
        source = '  // DIAGNOSTIC-BEGIN: example\r\nvoid example() {}\r\n\t// DIAGNOSTIC-END: example'
        self.assertEqual(source_region(source, 'example', 'example.cpp'), 'void example() {}\r\n')

    def test_reports_missing_duplicate_or_reversed_boundaries(self):
        begin = '// DIAGNOSTIC-BEGIN: example\n'
        end = '// DIAGNOSTIC-END: example\n'
        for source in ('', begin, end, begin + begin + end, begin + end + end, end + begin):
            with self.subTest(source=source):
                with self.assertRaisesRegex(ValueError, 'example.cpp:.*example'):
                    source_region(source, 'example', 'example.cpp')


if __name__ == '__main__':
    unittest.main()
