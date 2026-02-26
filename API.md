# Documentação da API — Dimasa Automation

Base URL: `http://localhost:3000`

- Formato de resposta: JSON
- Autenticação: não requer
- Fonte de dados: somente arquivos convertidos em `files/` (Excel/CSV → JSON)
- Observação: novos arquivos em `files/` são convertidos automaticamente para `.json` e o original é removido

## Arquivos

- GET `/api/files/last`
  - Retorna informações do último arquivo em `files/`
  - Resposta:
    ```json
    {
      "filename": "Compra20260223 (1).json",
      "size": 12345,
      "modifiedAt": "2026-02-23T16:05:01.123Z",
      "downloadUrl": "/api/files/Compra20260223%20(1).json"
    }
    ```

- GET `/api/files/:name`
  - Faz download do arquivo especificado (binário/JSON)

- GET `/api/files/last/json`
  - Retorna o conteúdo JSON do último `.json` em `files/`
  - Resposta segue estrutura de conversão:
    - Excel: `{ "type": "excel", "sheets": [{ "name": "...", "rows": [...] }] }`
    - CSV: `{ "type": "csv", "rows": [...] }`

- GET `/api/files/convert-last`
  - Converte o último arquivo não-JSON (Excel/CSV) para `.json` e remove o original
  - Resposta:
    ```json
    {
      "success": true,
      "jsonFile": "Compra20260223.json",
      "size": 45678,
      "details": { "sheetsCount": 1, "rowsTotal": 120 }
    }
    ```

## Notas Fiscais (derivadas dos arquivos em `files/`)

- GET `/api/invoices`
  - Lista NFs consolidadas dos arquivos convertidos
  - Filtros opcionais:
    - `q`: busca textual em campos de cabeçalho e itens (ex.: `?q=CG 160`)
    - Busca por campos diretos (ex.: `?nf=20781675` ou `?numeroNF=20781675`)
  - Exemplo de item:
    ```json
    {
      "nf": "20781675",
      "numeroNF": "20781675",
      "empresa": "(2)CRI",
      "serie": "27",
      "data": "2026-02-05T19:13:39.000Z",
      "emissao": "2026-02-03T03:00:00.000Z",
      "fornecedor": "MOTO HONDA DA AMAZONIA LTDA",
      "origemOperacao": "Veiculos      ",
      "items": [
        {
          "codigoProduto": "9C2KC2200TR458325",
          "produto": "CG 160 FAN",
          "valor": 14982,
          "quantidade": "1",
          "valorTotal": 14982,
          "valorLiquido": 14982,
          "icms": 1878.47,
          "frete": 581.36,
          "seguro": 90.52
        }
      ]
    }
    ```

- GET `/api/invoices/:nf`
  - Retorna cabeçalho + conjunto de itens para a NF informada

- GET `/api/invoices/:nf/items`
  - Retorna somente os itens da NF
  - Resposta:
    ```json
    {
      "nf": "20781675",
      "numeroNF": "20781675",
      "chaveAcesso": null,
      "itens": [ { ... } ],
      "products": []
    }
    ```
  - Observação: o array `itens` é preenchido a partir de `items` quando o dado vem da planilha convertida

## Ações (coordinates.json)

- GET `/api/actions`
  - Retorna o conteúdo completo de `coordinates.json`

- POST `/api/actions`
  - Substitui o conteúdo de `coordinates.json`
  - Body:
    ```json
    {
      "setup_steps": [ ... ],
      "invoice_loop_steps": [ ... ]
    }
    ```
  - Resposta: `{ "success": true }`

## Bot

- POST `/api/bot/start`
  - Inicia o processo do bot
  - Resposta: `{ "success": true, "message": "Bot started" }`

- POST `/api/bot/stop`
  - Para o processo do bot
  - Resposta: `{ "success": true, "message": "Bot stopped" }`

- POST `/api/bot/restart`
  - Reinicia o processo do bot
  - Resposta: `{ "success": true, "message": "Bot restarted" }`

- GET `/api/bot/status`
  - Retorna status do bot
  - Resposta: `{ "running": true }`

## Códigos de Erro

- 400: requisição inválida (ex.: parâmetro obrigatório ausente)
- 404: recurso não encontrado (ex.: NF inexistente)
- 500: erro interno (ex.: leitura/conversão falhou)

## Exemplos (curl)

```bash
curl http://localhost:3000/api/invoices
curl http://localhost:3000/api/invoices/20781675
curl http://localhost:3000/api/invoices/20781675/items
curl http://localhost:3000/api/files/last/json
curl -X POST http://localhost:3000/api/bot/start
```
