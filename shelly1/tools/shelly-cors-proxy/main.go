// Self-contained Shelly 1 Gen4 lock-state test tool.
//
// One exe: serves the test page itself and relays its RPC calls to the
// Shelly. Because the page and the relay share the same origin
// (localhost:8899), the browser never makes a cross-origin request, so
// there's nothing for CORS to block — no separate proxy step needed.
//
// Usage: double-click, or run shelly_cors_proxy.exe from a terminal.
// It opens http://localhost:8899 in your default browser automatically.
// Enter the Shelly's IP address in the page itself, same as before.
package main

import (
	_ "embed"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

//go:embed index.html
var indexHTML []byte

const addr = "127.0.0.1:8899"

func main() {
	client := &http.Client{Timeout: 5 * time.Second}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})

	// /proxy/<shelly-host>/rpc/... -> http://<shelly-host>/rpc/...
	http.HandleFunc("/proxy/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "only GET is proxied", http.StatusMethodNotAllowed)
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, "/proxy/")
		idx := strings.Index(rest, "/")
		if idx < 1 {
			http.Error(w, "missing Shelly host in request", http.StatusBadRequest)
			return
		}
		host, remotePath := rest[:idx], rest[idx:]

		url := "http://" + host + remotePath
		if r.URL.RawQuery != "" {
			url += "?" + r.URL.RawQuery
		}

		w.Header().Set("Content-Type", "application/json")
		resp, err := client.Get(url)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			w.Write([]byte(fmt.Sprintf(`{"error":%q}`, err.Error())))
			return
		}
		defer resp.Body.Close()
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})

	go func() {
		time.Sleep(300 * time.Millisecond)
		openBrowser("http://" + addr)
	}()

	fmt.Println("Shelly test page running at http://" + addr)
	fmt.Println("Close this window to stop.")
	if err := http.ListenAndServe(addr, nil); err != nil {
		fmt.Println("Failed to start:", err)
		fmt.Println("\nPress Enter to close...")
		fmt.Scanln()
	}
}

func openBrowser(url string) {
	if runtime.GOOS == "windows" {
		exec.Command("cmd", "/c", "start", "", url).Start()
	}
}
