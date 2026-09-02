library(shiny)

ui <- fluidPage(
  titlePanel("Playwright Coverage Fixture"),
  sidebarLayout(
    sidebarPanel(
      textInput("name", "Your name:", value = ""),
      selectInput("dataset", "Choose a dataset:",
                  choices = c("rock", "pressure", "cars")),
      sliderInput("bins", "Number of bins:",
                  min = 1, max = 50, value = 30),
      actionButton("go", "Update")
    ),
    mainPanel(
      tabsetPanel(
        tabPanel("Plot", plotOutput("distPlot")),
        tabPanel("Table", tableOutput("dataTable"))
      )
    )
  )
)

server <- function(input, output, session) {

  dataset <- reactive({
    input$go
    isolate(get(input$dataset, "package:datasets"))
  })

  output$distPlot <- renderPlot({
    data <- dataset()
    if (is.data.frame(data) && ncol(data) >= 2) {
      x <- data[, 2]
    } else {
      x <- data
    }
    bins <- seq(min(x), max(x), length.out = input$bins + 1)
    hist(x, breaks = bins, col = 'darkgray', border = 'white',
         main = input$dataset)
  })

  output$dataTable <- renderTable({
    head(dataset(), 10)
  })
}

shinyApp(ui = ui, server = server)
