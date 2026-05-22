(function () {
    document.querySelectorAll(".textarea-wrap").forEach((wrap) => {
        const note = wrap.querySelector(".note");
        const counter = wrap.querySelector(".counter");
        if (!note || !counter) return;

        const maxLength = note.maxLength > 0 ? note.maxLength : 100;

        function updateCounter() {
            counter.textContent = `${note.value.length}/${maxLength}`;
        }

        note.addEventListener("input", updateCounter);
        updateCounter();
    });
})();
