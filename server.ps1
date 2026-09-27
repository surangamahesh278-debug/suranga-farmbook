param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/manifest+json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}
$listener = $null
$port = $null

# Bind only to the computer's IPv4 loopback adapter. FarmBook is never exposed
# to other computers on the network.
foreach ($candidate in @(8000, 8001, 8010, 8080, 8081)) {
    $tryListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
    try {
        $tryListener.Start()
        $listener = $tryListener
        $port = $candidate
        break
    } catch {
        $tryListener.Stop()
    }
}

if ($null -eq $listener) {
    Write-Host 'Could not find an available local port (tried 8000, 8001, 8010, 8080 and 8081).'
    Write-Host 'Close another FarmBook/server window and try again.'
    exit 1
}

$baseUri = "http://localhost:$port/"
Write-Host ''
Write-Host 'Suranga FarmBook is running on this computer.' -ForegroundColor Green
Write-Host "Address: $baseUri" -ForegroundColor Cyan
Write-Host 'Keep this window open while using FarmBook. Press Ctrl+C here to stop it.'
Write-Host 'Farm records remain in this browser on this device.'
Write-Host ''
if (-not $NoOpen) { Start-Process $baseUri }

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        $stream = $client.GetStream()
        try {
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }
            while ($null -ne ($headerLine = $reader.ReadLine()) -and $headerLine.Length -gt 0) { }

            $parts = $requestLine.Split(' ', 3)
            $method = $parts[0]
            $status = 200
            $reason = 'OK'
            $contentType = 'application/octet-stream'
            $body = [byte[]]@()

            if ($method -notin @('GET', 'HEAD')) {
                $status = 405
                $reason = 'Method Not Allowed'
            } elseif ($parts.Count -lt 2) {
                $status = 400
                $reason = 'Bad Request'
            } else {
                $path = [Uri]::UnescapeDataString(($parts[1] -split '\?', 2)[0]).TrimStart('/')
                if ([string]::IsNullOrWhiteSpace($path)) { $path = 'index.html' }
                $path = $path.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
                $filePath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $path))
                $rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

                if (-not $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not [System.IO.File]::Exists($filePath)) {
                    $status = 404
                    $reason = 'Not Found'
                } else {
                    $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
                    if ($mime.ContainsKey($extension)) { $contentType = $mime[$extension] }
                    $body = [System.IO.File]::ReadAllBytes($filePath)
                }
            }

            $bodyLength = $body.Length
            $responseHeaders = "HTTP/1.1 $status $reason`r`nContent-Type: $contentType`r`nContent-Length: $bodyLength`r`nConnection: close`r`nCache-Control: no-cache`r`nX-Content-Type-Options: nosniff`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($responseHeaders)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($method -eq 'GET' -and $bodyLength -gt 0) { $stream.Write($body, 0, $bodyLength) }
            $stream.Flush()
        } catch {
            # Close a malformed or interrupted connection and continue serving
            # the app on the next request.
        } finally {
            if ($null -ne $reader) { $reader.Dispose() }
            $stream.Dispose()
            $client.Dispose()
        }
    }
} finally {
    $listener.Stop()
}
