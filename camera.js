(function () {
    document.querySelectorAll(".photo-card").forEach((card) => {
        if (card.dataset.cameraInit) return;
        card.dataset.cameraInit = "true";

        let input = card.querySelector(".photo-input");
        if (!input) {
            input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.capture = "environment";
            input.hidden = true;
            input.className = "photo-input";
            card.appendChild(input);
        }

        let preview = card.querySelector(".photo-card-image");

        function showPreview(dataUrl) {
            if (!preview) {
                preview = document.createElement("img");
                preview.className = "photo-card-image";
                card.insertBefore(preview, input);
            }

            preview.src = dataUrl;
            preview.alt = card.getAttribute("aria-label") || "Zdjęcie";
            card.classList.add("has-photo");
            card.classList.remove("add");
            card.setAttribute("aria-label", "Zmień zdjęcie");
        }

        function openPicker() {
            input.click();
        }

        card.addEventListener("click", openPicker);
        card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openPicker();
            }
        });

        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = () => showPreview(reader.result);
            reader.readAsDataURL(file);
            input.value = "";
        });
    });
})();
