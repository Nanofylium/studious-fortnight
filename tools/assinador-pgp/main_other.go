//go:build !windows

package main

// Modo de desenvolvimento (Linux/Mac): serve a mesma janela num navegador
// para testes. Os diálogos de arquivo respondem a partir de uma fila de teste.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
)

type platTeste struct {
	mu   sync.Mutex
	fila [][]string
}

func (p *platTeste) prox() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.fila) == 0 {
		return nil
	}
	r := p.fila[0]
	p.fila = p.fila[1:]
	return r
}
func (p *platTeste) AbrirArquivos(t string, v bool, f string) []string {
	log.Println("diálogo:", t)
	return p.prox()
}
func (p *platTeste) SalvarComo(t, n string) string {
	r := p.prox()
	if len(r) == 0 {
		return ""
	}
	return r[0]
}
func (p *platTeste) MostrarNaPasta(c string) { log.Println("mostrar:", c) }

func chamar(f interface{}, params []json.RawMessage) (interface{}, error) {
	v := reflect.ValueOf(f)
	if len(params) != v.Type().NumIn() {
		return nil, errors.New("function arguments mismatch")
	}
	var args []reflect.Value
	for i := range params {
		arg := reflect.New(v.Type().In(i))
		if err := json.Unmarshal(params[i], arg.Interface()); err != nil {
			return nil, err
		}
		args = append(args, arg.Elem())
	}
	res := v.Call(args)
	errT := reflect.TypeOf((*error)(nil)).Elem()
	switch len(res) {
	case 0:
		return nil, nil
	case 1:
		if res[0].Type().Implements(errT) {
			if !res[0].IsNil() {
				return nil, res[0].Interface().(error)
			}
			return nil, nil
		}
		return res[0].Interface(), nil
	default:
		if !res[1].IsNil() {
			return res[0].Interface(), res[1].Interface().(error)
		}
		return res[0].Interface(), nil
	}
}

func main() {
	plat := &platTeste{}
	app := NovoApp(plat, os.Args[1:])
	binds := ligacoes(app)
	var nomes []string
	for n := range binds {
		nomes = append(nomes, n)
	}
	shim := "<script>(function(){var n=" + mustJSON(nomes) + ";n.forEach(function(k){window[k]=function(){var a=Array.prototype.slice.call(arguments);return fetch('/call/'+k,{method:'POST',body:JSON.stringify(a)}).then(function(r){return r.json()}).then(function(x){if(x.error)throw x.error;return x.result})}})})();</script>"
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, strings.Replace(pagina(), "<head>", "<head>"+shim, 1))
	})
	http.HandleFunc("/call/", func(w http.ResponseWriter, r *http.Request) {
		var params []json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&params)
		f, ok := binds[strings.TrimPrefix(r.URL.Path, "/call/")]
		out := map[string]interface{}{}
		if !ok {
			out["error"] = "sem função"
		} else if res, err := chamar(f, params); err != nil {
			out["error"] = err.Error()
		} else {
			out["result"] = res
		}
		json.NewEncoder(w).Encode(out)
	})
	http.HandleFunc("/teste/fila", func(w http.ResponseWriter, r *http.Request) {
		var f []string
		_ = json.NewDecoder(r.Body).Decode(&f)
		plat.mu.Lock()
		plat.fila = append(plat.fila, f)
		plat.mu.Unlock()
	})
	porta := os.Getenv("PORTA")
	if porta == "" {
		porta = "8765"
	}
	fmt.Println("http://127.0.0.1:" + porta)
	log.Fatal(http.ListenAndServe("127.0.0.1:"+porta, nil))
}

func mustJSON(v interface{}) string { b, _ := json.Marshal(v); return string(b) }
