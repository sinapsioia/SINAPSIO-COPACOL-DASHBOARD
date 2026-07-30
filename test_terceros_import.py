import unittest

from scripts import import_terceros_credito as importer


class ThirdPartyImportTests(unittest.TestCase):
    def test_main_branch_wins_regardless_of_input_order(self):
        rows = [
            {"nit": "123", "sucursal": "1", "vendedor_codigo": "35"},
            {"nit": "123", "sucursal": "0", "vendedor_codigo": "39"},
            {"nit": "123", "sucursal": "2", "vendedor_codigo": "35"},
        ]

        result = importer.dedupe_by_nit(rows)

        self.assertEqual(1, len(result))
        self.assertEqual("0", result[0]["sucursal"])
        self.assertEqual("39", result[0]["vendedor_codigo"])

    def test_conflicting_seller_codes_are_reported(self):
        rows = [
            {"nit": "123", "sucursal": "0", "vendedor_codigo": "39"},
            {"nit": "123", "sucursal": "1", "vendedor_codigo": "35"},
            {"nit": "456", "sucursal": "0", "vendedor_codigo": "18"},
        ]

        self.assertEqual(["123"], importer.conflicting_nits(rows, "vendedor_codigo"))


if __name__ == "__main__":
    unittest.main()
