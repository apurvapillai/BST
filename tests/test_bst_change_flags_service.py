import unittest
from types import SimpleNamespace

from services.bst_change_flags_service import BSTChangeFlagsService


class BSTChangeFlagsServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = BSTChangeFlagsService()

    def _reel(self, reel_code: str, reference_count: int) -> SimpleNamespace:
        reference_images = [
            SimpleNamespace(
                ref_image_id=index + 1,
                filename=f"reference-{index + 1}.png",
                format=float(index + 1),
                image_src=f"/static/reference-{index + 1}.png",
            )
            for index in range(reference_count)
        ]
        return SimpleNamespace(
            reel_code=reel_code,
            reference_images=reference_images,
            sensitivity_sets=[],
            masks=[],
        )

    def test_reference_only_changes_use_image_delta_label(self) -> None:
        previous = self._reel("R-100", 1)
        current = self._reel("R-101", 2)

        flag = self.service._build_bst_flag({"latest": current, "previous": previous})

        self.assertEqual(flag["state"], "changed")
        self.assertEqual(flag["label"], "1 Change")
        self.assertEqual(flag["details"][0]["summary"], "1 Change")

    def test_reference_only_changes_pluralize_correctly(self) -> None:
        previous = self._reel("R-200", 1)
        current = self._reel("R-201", 3)

        flag = self.service._build_bst_flag({"latest": current, "previous": previous})

        self.assertEqual(flag["state"], "changed")
        self.assertEqual(flag["label"], "2 Changes")
        self.assertEqual(flag["details"][0]["summary"], "2 Changes")

    def test_no_prior_bst_reel_without_changes_is_good(self) -> None:
        current = self._reel("R-300", 1)
        current.reference_images = []

        flag = self.service._build_bst_flag({"latest": current, "previous": None})

        self.assertEqual(flag["state"], "unchanged")
        self.assertEqual(flag["label"], "Good")
        self.assertEqual(flag["details"], [])

    def test_mask_changes_build_a_sequence_when_multiple_masks_change(self) -> None:
        previous = SimpleNamespace(
            reel_code="R-400",
            reference_images=[
                SimpleNamespace(ref_image_id=1, filename="ref-1.png", format=1.0, image_src="/static/ref-1.png"),
                SimpleNamespace(ref_image_id=2, filename="ref-2.png", format=2.0, image_src="/static/ref-2.png"),
            ],
            masks=[
                SimpleNamespace(mask_id=1, xml_id="A", sensitivitysetid="1", coords="1,1,10,10", format_value=1.0),
                SimpleNamespace(mask_id=2, xml_id="B", sensitivitysetid="2", coords="2,2,20,20", format_value=2.0),
            ],
        )
        current = SimpleNamespace(
            reel_code="R-401",
            reference_images=[
                SimpleNamespace(ref_image_id=1, filename="ref-1.png", format=1.0, image_src="/static/ref-1.png"),
                SimpleNamespace(ref_image_id=2, filename="ref-2.png", format=2.0, image_src="/static/ref-2.png"),
            ],
            masks=[
                SimpleNamespace(mask_id=1, xml_id="A", sensitivitysetid="1", coords="3,3,12,12", format_value=1.0),
                SimpleNamespace(mask_id=2, xml_id="B", sensitivitysetid="2", coords="4,4,24,24", format_value=2.0),
            ],
        )

        changes = self.service._mask_changes(previous, current)

        self.assertEqual(len(changes), 1)
        comparison = changes[0]["maskComparison"]
        self.assertEqual(len(comparison["sequence"]), 3)
        self.assertEqual(comparison["sequence"][0]["label"], "Initial")
        self.assertEqual(comparison["sequence"][1]["label"], "After change 1")
        self.assertEqual(comparison["sequence"][2]["label"], "After change 2")
        self.assertEqual(len(comparison["sequence"][2]["masks"]), 2)


if __name__ == "__main__":
    unittest.main()
