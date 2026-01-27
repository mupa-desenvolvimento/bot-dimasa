// TagUI Flow for Vision Cloud Automation

// Set timeout for retries (User requested 10 attempts, default step wait is 10s, timeout 30s covers it)
timeout 30

// 1. Login
echo "Navigating to Login..."
https://workspace.sisand.com.br/login
type //input[placeholder*='username'] as 089.jeanp
type //input[type='password'] as Dimasa1379@
click //button[contains(., 'Entrar')]

// 2. Vision Cloud
echo "Waiting for Vision Cloud..."
wait 5
// Visual search using text locator (DOM-based but robust)
// If Vision Cloud is not found, it will retry for 30 seconds
click Vision Cloud

// 3. Faturamento
echo "Searching for Faturamento..."
wait 5
click Faturamento

// 4. Entrada
echo "Searching for Entrada..."
wait 2
click Entrada

// 5. Lista de Notas
echo "Searching for Lista de Notas..."
wait 2
click Lista de Notas

// 6. Em Trânsito
echo "Searching for Em Trânsito..."
wait 5
click Em Trânsito

// 7. Filter Origem
echo "Setting filter Origem..."
wait 2
click Origem
type Produto
click [enter]

// 8. Open Invoice
echo "Opening first invoice..."
wait 3
// Double click the first row in the grid
dclick //table//tr[1]

echo "Automation completed successfully."
