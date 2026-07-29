import unittest

import app


class AdvisorResolutionTests(unittest.TestCase):
    def setUp(self):
        self.catalog = {
            "18": {"codigo": "0018", "nombre": "JHON JAIRO CARMONA"},
            "33": {"codigo": "0033", "nombre": "GUSTAVO ALDOLFO GOMEZ CAMAYO"},
        }

    def test_master_seller_replaces_stale_client_and_invoice_seller(self):
        client = {"nit": "1089718173", "asesor_codigo": "0018", "asesor_nombre": "JHON JAIRO CARMONA"}
        terms = {"1089718173": {"nit": "1089718173", "activo": True, "vendedor_codigo": "33"}}

        resolved = app.apply_master_advisor(client, terms, self.catalog)
        code, name = app.invoice_seller(
            {"asesor_codigo": "0018", "asesor_nombre": "JHON JAIRO CARMONA"},
            resolved,
        )

        self.assertEqual(("0033", "GUSTAVO ALDOLFO GOMEZ CAMAYO"), (code, name))
        self.assertEqual("terceros", resolved["asesor_fuente"])

    def test_manual_override_wins_over_master_seller(self):
        client = {"nit": "1089718173", "asesor_codigo": "0018", "asesor_nombre": "JHON JAIRO CARMONA"}
        terms = {"1089718173": {"nit": "1089718173", "activo": True, "vendedor_codigo": "33"}}
        overrides = {
            "1089718173": {
                "asesor_codigo": "0019",
                "asesor_nombre": "CAROLINA CHARRIA DIAZ",
                "updated_at": "2026-07-29T12:00:00Z",
            }
        }

        from_master = app.apply_master_advisor(client, terms, self.catalog)
        resolved = app.apply_advisor_override(from_master, overrides)

        self.assertEqual(("0019", "CAROLINA CHARRIA DIAZ"), app.invoice_seller({}, resolved))
        self.assertEqual("override", resolved["asesor_fuente"])

    def test_remove_advisor_override_does_not_fall_back_to_invoice(self):
        client = {
            "nit": "1111538216",
            "asesor_codigo": None,
            "asesor_nombre": None,
            "tiene_override_asesor": True,
            "asesor_fuente": "override",
        }
        invoice = {"asesor_codigo": "0018", "asesor_nombre": "JHON JAIRO CARMONA"}

        self.assertEqual(("sin_codigo", "Sin asesor"), app.invoice_seller(invoice, client))

    def test_client_assignment_wins_when_master_record_is_missing(self):
        client = {
            "nit": "1111538216",
            "asesor_codigo": "0000",
            "asesor_nombre": "VENDEDOR NO CATALOGADO",
        }
        invoice = {"asesor_codigo": "0018", "asesor_nombre": "JHON JAIRO CARMONA"}

        resolved = app.apply_master_advisor(client, {}, self.catalog)

        self.assertEqual(("0000", "VENDEDOR NO CATALOGADO"), app.invoice_seller(invoice, resolved))
        self.assertEqual("cliente", resolved["asesor_fuente"])

    def test_unknown_master_code_remains_traceable(self):
        client = {"nit": "6105598", "asesor_codigo": "0018", "asesor_nombre": "JHON JAIRO CARMONA"}
        terms = {"6105598": {"nit": "6105598", "activo": True, "vendedor_codigo": "36"}}

        resolved = app.apply_master_advisor(client, terms, self.catalog)

        self.assertEqual(("0036", "ASESOR COD. 0036"), app.invoice_seller({}, resolved))

    def test_invoice_is_only_used_when_client_has_no_assignment(self):
        invoice = {"asesor_codigo": "0018", "asesor_nombre": "JHON JAIRO CARMONA"}

        self.assertEqual(("0018", "JHON JAIRO CARMONA"), app.invoice_seller(invoice, {}))


if __name__ == "__main__":
    unittest.main()
