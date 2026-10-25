# Forja — studio mastering para stems

Arraste os stems gerados no Suno (voz, bateria, baixo...) ou uma faixa pronta.
O Forja repara estalos e buracos, tira o som metálico, mixa os stems e
masteriza no volume certo. Todo o processamento roda na sua máquina.

## App de desktop

Instaladores prontos: aba **Actions** do GitHub, workflow **Desktop app**,
última execução, seção *Artifacts* (`Forja-Windows`, `Forja-macOS`,
`Forja-Linux`). Uma tag `v*` publica os mesmos arquivos numa release.

Os builds não são assinados. No Windows, clique em "Mais informações" e
"Executar assim mesmo"; no macOS, clique com o botão direito no app e
escolha "Abrir" na primeira vez.

Para rodar a partir do código:

```bash
npm install
npm run desktop        # gera o build e abre a janela
npm run dist:desktop   # gera o instalador do seu sistema em release/
```

## Web (Base44)

```bash
npm install
npm run dev
```

## Verificações

```bash
npm test && npm run lint && npm run build
```
