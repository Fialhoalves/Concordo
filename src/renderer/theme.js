/* Aplica o tema salvo antes da primeira pintura (evita o "piscar" do tema errado). */
(function () {
  try {
    var t = localStorage.getItem('concordo.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* sem armazenamento: segue o tema do sistema */
  }
})();
