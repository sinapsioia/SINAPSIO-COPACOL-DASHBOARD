"""Override de condicion -> el vencimiento se recalcula, no solo la etiqueta.

Caso reportado por COPACOL: FERRETERIA MILENIUM SAS (NIT 902029113) se corrigio
de contado a 60 dias y el tablero seguia mostrandola vencida con el vencimiento
de contado.
"""

import unittest

import app


MILENIUM = {
    "nit": "902029113",
    "numero_factura": "00000002757",
    "fecha_emision": "2026-07-15",
    "fecha_vencimiento": "2026-07-16",  # contado: emision + 1
    "dias_mora": 35,                    # => la carga fue al corte 2026-08-20
    "monto": 759965.60,
}

CLIENTE_60D = {
    "nit": "902029113",
    "razon_social": "FERRETERIA MILENIUM SAS",
    "condicion_pago": "credito_60d",
    "tiene_override_condicion": True,
}


class CondicionVencimientoTests(unittest.TestCase):
    def test_override_a_60_dias_mueve_el_vencimiento(self):
        fixed = app.reprice_invoice_due_date(MILENIUM, 60, "2026-08-20")

        self.assertEqual("2026-09-13", fixed["fecha_vencimiento"])
        self.assertEqual(-24, fixed["dias_mora"])
        self.assertEqual("vigente", app.aging_bucket(fixed["dias_mora"]))

    def test_deduce_el_corte_cuando_no_se_lo_pasan(self):
        """venc + dias_mora reconstruye la fecha de corte de la carga."""
        fixed = app.reprice_invoice_due_date(MILENIUM, 60)

        self.assertEqual("2026-09-13", fixed["fecha_vencimiento"])
        self.assertEqual(-24, fixed["dias_mora"])

    def test_conserva_los_valores_del_archivo_para_trazabilidad(self):
        fixed = app.reprice_invoice_due_date(MILENIUM, 60, "2026-08-20")

        self.assertEqual("2026-07-16", fixed["fecha_vencimiento_archivo"])
        self.assertEqual(35, fixed["dias_mora_archivo"])
        self.assertTrue(fixed["vencimiento_recalculado"])

    def test_sin_override_la_factura_queda_intacta(self):
        self.assertIs(MILENIUM, app.reprice_invoice_due_date(MILENIUM, None))

    def test_plazo_que_no_mueve_la_fecha_deja_la_factura_intacta(self):
        """Contado ya daba emision + 1: no hay nada que recalcular."""
        self.assertIs(MILENIUM, app.reprice_invoice_due_date(MILENIUM, 1))

    def test_factura_sin_fecha_de_emision_no_se_toca(self):
        sin_emision = {**MILENIUM, "fecha_emision": None}

        self.assertIs(sin_emision, app.reprice_invoice_due_date(sin_emision, 60))

    def test_el_plazo_del_override_sale_de_la_condicion_elegida(self):
        self.assertEqual(60, app.manual_condition_plazo(CLIENTE_60D))
        self.assertEqual(45, app.manual_condition_plazo({**CLIENTE_60D, "condicion_pago": "credito_45d"}))
        self.assertEqual(1, app.manual_condition_plazo({**CLIENTE_60D, "condicion_pago": "contado"}))

    def test_sin_override_no_hay_plazo_manual(self):
        self.assertIsNone(app.manual_condition_plazo({"condicion_pago": "credito_60d"}))
        self.assertIsNone(app.manual_condition_plazo({"tiene_override_condicion": True}))

    def test_condicion_invalida_no_se_toma_como_plazo(self):
        raro = {"tiene_override_condicion": True, "condicion_pago": "platam_30d"}

        self.assertIsNone(app.manual_condition_plazo(raro))

    def test_resolve_client_condition_sigue_devolviendo_condicion_y_plazo(self):
        self.assertEqual(("credito_60d", 60), app.resolve_client_condition(CLIENTE_60D, "contado", 1))
        self.assertEqual(("contado", 1), app.resolve_client_condition({}, "contado", 1))
        self.assertEqual(("sin_condicion_real", None), app.resolve_client_condition({}, None, None))


if __name__ == "__main__":
    unittest.main()
